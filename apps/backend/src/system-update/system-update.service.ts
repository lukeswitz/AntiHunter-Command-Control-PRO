import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface UpdateCheckResult {
  updateAvailable: boolean;
  diverged: boolean;
  localCommit: string;
  remoteCommit: string;
  commitsBehind: number;
  commitsAhead: number;
  lastChecked: string;
}

export interface UpdateResult {
  success: boolean;
  message: string;
  previousCommit: string;
  newCommit: string;
  stashed: boolean;
  stashRestored: boolean;
}

@Injectable()
export class SystemUpdateService {
  private readonly logger = new Logger(SystemUpdateService.name);
  private readonly repoPath = process.cwd();

  async checkForUpdate(): Promise<UpdateCheckResult> {
    try {
      // Fetch latest from remote
      await execAsync('git fetch origin main', { cwd: this.repoPath });

      // Get local HEAD commit
      const { stdout: localCommit } = await execAsync('git rev-parse HEAD', {
        cwd: this.repoPath,
      });

      // Get remote main commit
      const { stdout: remoteCommit } = await execAsync('git rev-parse origin/main', {
        cwd: this.repoPath,
      });

      const localHash = localCommit.trim();
      const remoteHash = remoteCommit.trim();

      // Count commits behind and ahead
      let commitsBehind = 0;
      let commitsAhead = 0;

      if (localHash !== remoteHash) {
        try {
          const { stdout: behindOutput } = await execAsync(
            'git rev-list --count HEAD..origin/main',
            { cwd: this.repoPath },
          );
          commitsBehind = parseInt(behindOutput.trim(), 10) || 0;
        } catch {
          commitsBehind = 0;
        }

        try {
          const { stdout: aheadOutput } = await execAsync(
            'git rev-list --count origin/main..HEAD',
            { cwd: this.repoPath },
          );
          commitsAhead = parseInt(aheadOutput.trim(), 10) || 0;
        } catch {
          commitsAhead = 0;
        }
      }

      // Diverged = both behind AND ahead
      const diverged = commitsBehind > 0 && commitsAhead > 0;
      // Update available only if behind and NOT diverged (can fast-forward)
      const updateAvailable = commitsBehind > 0 && !diverged;

      return {
        updateAvailable,
        diverged,
        localCommit: localHash.substring(0, 7),
        remoteCommit: remoteHash.substring(0, 7),
        commitsBehind,
        commitsAhead,
        lastChecked: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error('Failed to check for updates', error);
      throw new Error('Failed to check for updates: ' + (error as Error).message);
    }
  }

  async performUpdate(): Promise<UpdateResult> {
    const previousCommit = await this.getCurrentCommit();
    let stashed = false;
    let stashRestored = false;

    try {
      // Check for local changes that need stashing
      const hasChanges = await this.hasLocalChanges();

      if (hasChanges) {
        this.logger.log('Local changes detected, stashing...');
        await execAsync('git stash push -m "auto-stash-before-update"', {
          cwd: this.repoPath,
        });
        stashed = true;
      }

      // Fetch and check if we can safely fast-forward
      this.logger.log('Fetching latest from origin/main...');
      await execAsync('git fetch origin main', { cwd: this.repoPath });

      // Check if we can fast-forward (no local commits ahead of remote)
      const canFF = await this.canFastForward();
      if (!canFF) {
        throw new Error(
          'Cannot auto-update: local branch has diverged from origin/main. ' +
            'You have local commits not in the remote. Please merge manually.',
        );
      }

      // Safe fast-forward merge
      this.logger.log('Applying fast-forward update...');
      await execAsync('git merge --ff-only origin/main', { cwd: this.repoPath });

      const newCommit = await this.getCurrentCommit();

      // Restore stash if we stashed
      if (stashed) {
        try {
          this.logger.log('Restoring stashed changes...');
          await execAsync('git stash pop', { cwd: this.repoPath });
          stashRestored = true;
        } catch (stashError) {
          this.logger.warn(
            'Failed to auto-restore stash, manual intervention may be needed',
            stashError,
          );
          // Don't fail the update, but note that stash wasn't restored
          stashRestored = false;
        }
      }

      return {
        success: true,
        message:
          stashed && !stashRestored
            ? 'Update successful. Stashed changes could not be auto-restored - run "git stash pop" manually.'
            : 'Update successful.',
        previousCommit: previousCommit.substring(0, 7),
        newCommit: newCommit.substring(0, 7),
        stashed,
        stashRestored,
      };
    } catch (error) {
      this.logger.error('Update failed', error);

      // Try to restore stash if we stashed and update failed
      if (stashed && !stashRestored) {
        try {
          await execAsync('git stash pop', { cwd: this.repoPath });
          stashRestored = true;
        } catch {
          this.logger.warn('Could not restore stash after failed update');
        }
      }

      throw new Error('Update failed: ' + (error as Error).message);
    }
  }

  private async getCurrentCommit(): Promise<string> {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: this.repoPath });
    return stdout.trim();
  }

  private async hasLocalChanges(): Promise<boolean> {
    try {
      const { stdout: statusOutput } = await execAsync('git status --porcelain', {
        cwd: this.repoPath,
      });
      return statusOutput.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async canFastForward(): Promise<boolean> {
    try {
      // Check if HEAD is an ancestor of origin/main (can fast-forward)
      await execAsync('git merge-base --is-ancestor HEAD origin/main', {
        cwd: this.repoPath,
      });
      return true;
    } catch {
      // Exit code 1 means HEAD is not an ancestor (branches diverged)
      return false;
    }
  }
}

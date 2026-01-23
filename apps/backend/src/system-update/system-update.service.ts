import { Injectable, Logger } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface UpdateCheckResult {
  updateAvailable: boolean;
  localCommit: string;
  remoteCommit: string;
  commitsBehind: number;
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

      // Count commits behind
      let commitsBehind = 0;
      if (localHash !== remoteHash) {
        try {
          const { stdout: countOutput } = await execAsync(
            `git rev-list --count HEAD..origin/main`,
            { cwd: this.repoPath },
          );
          commitsBehind = parseInt(countOutput.trim(), 10) || 0;
        } catch {
          // If counting fails, at least we know there's a difference
          commitsBehind = localHash !== remoteHash ? 1 : 0;
        }
      }

      return {
        updateAvailable: localHash !== remoteHash && commitsBehind > 0,
        localCommit: localHash.substring(0, 7),
        remoteCommit: remoteHash.substring(0, 7),
        commitsBehind,
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

      // Pull the latest changes - try fast-forward first, then rebase if diverged
      this.logger.log('Pulling latest changes from origin/main...');
      try {
        await execAsync('git pull --ff-only origin main', { cwd: this.repoPath });
      } catch {
        // If fast-forward fails (divergent branches), try rebase to preserve local commits
        this.logger.warn('Fast-forward failed, attempting rebase onto origin/main...');
        await execAsync('git fetch origin main', { cwd: this.repoPath });
        try {
          await execAsync('git rebase origin/main', { cwd: this.repoPath });
        } catch (rebaseError) {
          // Rebase failed (conflicts), abort and report
          await execAsync('git rebase --abort', { cwd: this.repoPath }).catch(() => {});
          throw new Error(
            'Update failed due to conflicts. Your local changes conflict with upstream. ' +
              'Please resolve manually with: git fetch origin main && git rebase origin/main',
          );
        }
      }

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
}

import { Controller, Get, NotFoundException } from '@nestjs/common';

import { VideoAddonService } from './video-addon.service';

@Controller('video')
export class VideoController {
  constructor(private readonly videoAddonService: VideoAddonService) {}

  @Get('fpv/status')
  getStatus() {
    return this.videoAddonService.getStatus();
  }

  @Get('fpv/frame')
  getFrame() {
    const frame = this.videoAddonService.getLastFrame();
    if (!frame) {
      throw new NotFoundException('No FPV frame captured yet');
    }
    return frame;
  }
}

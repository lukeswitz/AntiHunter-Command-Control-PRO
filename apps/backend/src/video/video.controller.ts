import { Body, Controller, Get, NotFoundException, Put } from '@nestjs/common';

import { UpdateFpvConfigDto } from './dto/update-fpv-config.dto';
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

  @Get('fpv/config')
  getConfig() {
    return this.videoAddonService.getConfig();
  }

  @Put('fpv/config')
  updateConfig(@Body() dto: UpdateFpvConfigDto) {
    return this.videoAddonService.updateConfig(dto);
  }
}

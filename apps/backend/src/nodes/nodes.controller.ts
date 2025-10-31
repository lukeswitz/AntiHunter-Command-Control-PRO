import { Controller, Delete, Get } from '@nestjs/common';

import { NodesService } from './nodes.service';

@Controller('nodes')
export class NodesController {
  constructor(private readonly nodesService: NodesService) {}

  @Get()
  listNodes() {
    return this.nodesService.getSnapshot();
  }

  @Delete()
  clearNodes() {
    return this.nodesService.clearAll();
  }
}

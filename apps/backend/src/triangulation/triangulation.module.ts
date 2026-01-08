import { Module } from '@nestjs/common';

import { TriangulationSessionService } from './triangulation-session.service';

@Module({
  providers: [TriangulationSessionService],
  exports: [TriangulationSessionService],
})
export class TriangulationModule {}

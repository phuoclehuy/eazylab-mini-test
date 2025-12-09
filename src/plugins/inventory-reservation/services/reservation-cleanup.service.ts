import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { JobQueue, JobQueueService, Logger, ProcessContext, RequestContext } from '@vendure/core';
import { ReservationService } from './reservation.service';

const loggerCtx = 'ReservationCleanupService';

/**
 * Service chạy background job để cleanup expired reservations
 */
@Injectable()
export class ReservationCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
    private cleanupQueue!: JobQueue<any>;
    private intervalHandle?: NodeJS.Timeout;

    constructor(
        private jobQueueService: JobQueueService,
        private reservationService: ReservationService,
        private processContext: ProcessContext,
    ) {}

    async onApplicationBootstrap() {
        if (!this.processContext.isServer) {
            return;
        }

        // Tạo job queue cho cleanup task
        this.cleanupQueue = await this.jobQueueService.createQueue({
            name: 'reservation-cleanup',
            process: async (job) => {
                Logger.debug('Running reservation cleanup job', loggerCtx);
                const ctx = RequestContext.empty();
                const cleaned = await this.reservationService.cleanupExpiredReservations(ctx);
                
                return {
                    cleaned,
                    timestamp: new Date().toISOString(),
                };
            },
        });

        // Schedule cleanup job mỗi 1 phút
        this.scheduleCleanup(60 * 1000); // 1 minute
        
        Logger.info('Reservation cleanup service initialized', loggerCtx);
    }

    async onModuleDestroy() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
        }
    }

    /**
     * Schedule cleanup job với interval cho trước
     */
    private scheduleCleanup(intervalMs: number) {
        this.intervalHandle = setInterval(() => {
            this.cleanupQueue.add({} as any, { retries: 3 });
        }, intervalMs);
    }
}

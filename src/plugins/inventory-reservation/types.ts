import { CustomOrderStates } from '@vendure/core';

/**
 * Custom order states for the inventory reservation plugin
 */
declare module '@vendure/core' {
    interface CustomOrderStates {
        // Không cần thêm state mới, dùng state mặc định của Vendure
    }
}

/**
 * Status của reservation
 */
export enum ReservationStatus {
    /**
     * Hàng đang được giữ tạm thời (khách chưa thanh toán)
     */
    RESERVED = 'RESERVED',
    
    /**
     * Đã thanh toán thành công, chuyển thành Allocation của Vendure
     */
    CONFIRMED = 'CONFIRMED',
    
    /**
     * Đã giải phóng (timeout hoặc cancel)
     */
    RELEASED = 'RELEASED',
}

/**
 * Config options cho plugin
 */
export interface ReservationPluginOptions {
    /**
     * Thời gian giữ hàng (milliseconds)
     * Default: 15 phút
     */
    reservationTTL?: number;
    
    /**
     * Interval chạy cleanup job (milliseconds)
     * Default: 1 phút
     */
    cleanupInterval?: number;
    
    /**
     * Có sử dụng Redis distributed lock không
     * Bật khi chạy multi-server
     * Default: false
     */
    enableDistributedLock?: boolean;
    
    /**
     * Có tự động extend thời gian khi customer update giỏ hàng không
     * Default: true
     */
    extendOnUpdate?: boolean;
    
    /**
     * Redis config (nếu enableDistributedLock = true)
     */
    redisConfig?: {
        host: string;
        port: number;
        password?: string;
    } | undefined;
}

/**
 * Lỗi khi không đủ hàng để reserve
 */
export class InsufficientStockForReservationError extends Error {
    constructor(
        public readonly variantId: string,
        public readonly requestedQuantity: number,
        public readonly availableQuantity: number,
    ) {
        super(
            `Insufficient stock for reservation. Requested: ${requestedQuantity}, Available: ${availableQuantity}`
        );
    }
}

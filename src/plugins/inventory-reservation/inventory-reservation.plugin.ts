import { PluginCommonModule, VendurePlugin } from '@vendure/core';
import { StockReservation } from './entities/stock-reservation.entity';
import { ReservationService } from './services/reservation.service';
import { ReservationCleanupService } from './services/reservation-cleanup.service';
import { reservationOrderProcess } from './config/reservation-order-process';
import { ReservationPluginOptions } from './types';

/**
 * # Inventory Reservation Plugin
 * 
 * Plugin này implement tính năng "Giữ hàng tạm thời" cho Vendure.
 * 
 * ## Tính năng chính:
 * - Tự động giữ hàng khi khách thêm vào giỏ
 * - Ngăn overselling trong môi trường concurrent
 * - Tự động giải phóng hàng khi timeout hoặc cancel
 * - Chuyển reservation thành allocation khi thanh toán thành công
 * 
 * ## Cách sử dụng:
 * 
 * ```typescript
 * // vendure-config.ts
 * import { InventoryReservationPlugin } from './plugins/inventory-reservation';
 * 
 * export const config = {
 *   plugins: [
 *     InventoryReservationPlugin.init({
 *       reservationTTL: 15 * 60 * 1000, // 15 phút
 *       cleanupInterval: 60 * 1000, // 1 phút
 *       extendOnUpdate: true,
 *     })
 *   ]
 * }
 * ```
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    entities: [StockReservation],
    providers: [ReservationService, ReservationCleanupService],
    configuration: (config) => {
        // Thêm OrderProcess vào config
        config.orderOptions.process.push(reservationOrderProcess);

        return config;
    },
})
export class InventoryReservationPlugin {
    private static _options: ReservationPluginOptions;

    /**
     * Initialize plugin với options
     */
    static init(options: ReservationPluginOptions): typeof InventoryReservationPlugin {
        this._options = options;
        return this;
    }

    /**
     * Get plugin options (for testing)
     */
    static getOptions(): ReservationPluginOptions {
        return this._options;
    }
}

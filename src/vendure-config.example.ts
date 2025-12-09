import { VendureConfig } from '@vendure/core';
import { defaultOrderProcess } from '@vendure/core';
import { InventoryReservationPlugin } from './plugins/inventory-reservation';

/**
 * Ví dụ cấu hình Vendure với Inventory Reservation Plugin
 */
export const config: Partial<VendureConfig> = {
    // ... other config

    /**
     * Plugins
     */
    plugins: [
        // Thêm Inventory Reservation Plugin
        InventoryReservationPlugin.init({
            // Thời gian giữ hàng: 15 phút
            reservationTTL: 15 * 60 * 1000,
            
            // Chạy cleanup job mỗi 1 phút
            cleanupInterval: 60 * 1000,
            
            // Tự động extend thời gian khi khách update giỏ hàng
            extendOnUpdate: true,
            
            // Bật distributed lock với Redis (cho multi-server)
            enableDistributedLock: false, // Set true nếu chạy nhiều server
            
            // Redis config (nếu enableDistributedLock = true)
            redisConfig: {
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                password: process.env.REDIS_PASSWORD,
            },
        }),

        // ... other plugins
    ],

    /**
     * Database config với connection pooling tối ưu
     */
    dbConnectionOptions: {
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'vendure',
        username: process.env.DB_USERNAME || 'vendure',
        password: process.env.DB_PASSWORD,
        
        // Connection pooling
        extra: {
            // Maximum connections
            max: 20,
            // Minimum idle connections
            min: 5,
            // Connection timeout
            connectionTimeoutMillis: 5000,
            // Idle timeout
            idleTimeoutMillis: 30000,
        },

        // Logging
        logging: process.env.NODE_ENV === 'development',
        
        // Migrations
        migrations: ['migrations/*.ts'],
        synchronize: false, // Always use migrations in production!
    },

    /**
     * Order options
     */
    orderOptions: {
        // Order process (plugin tự động thêm reservationOrderProcess)
        process: [defaultOrderProcess],
        
        // Order code strategy
        orderCodeStrategy: {
            // Custom order code format
            generate: (ctx) => {
                const timestamp = Date.now();
                const random = Math.random().toString(36).substr(2, 9).toUpperCase();
                return `ORD-${timestamp}-${random}`;
            },
        },
    },
};

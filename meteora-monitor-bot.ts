import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import DLMM, { LbPosition } from '@meteora-ag/dlmm';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Telegram bot
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env file");
}

// Assert CHAT_ID as string since we've checked it's not undefined
const chatId = CHAT_ID as string;
const bot = new Telegraf(BOT_TOKEN);

interface PositionStatus {
    positionKey: string;
    isInRange: boolean;
    lastNotified: boolean;
}
async function initializeClient(): Promise<{ connection: Connection; dlmm: DLMM }> {
    const RPC = "https://neat-magical-market.solana-mainnet.quiknode.pro/22f4786138ebd920140d051f0ebdc6da71f058db/";
    const poolAddress = new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6");
    const connection = new Connection(RPC, "finalized");
    const dlmm = await DLMM.create(connection, poolAddress, {
      cluster: "mainnet-beta",
    });
    return { connection, dlmm };
  }
  
  function getUserKeypair(): Keypair {
    const PRIVATE_KEY = process.env.PRIVATE_KEY;
    if (!PRIVATE_KEY) {
        throw new Error("PRIVATE_KEY not found in environment variables");
    }
    const privateKeyArray = JSON.parse(PRIVATE_KEY);
    const privateKeyBytes = new Uint8Array(privateKeyArray);
    return Keypair.fromSecretKey(privateKeyBytes);
  }

class MeteoraMonitor {
    private connection: Connection;
    private dlmm: DLMM;
    private user: Keypair;
    private positionStatuses: Map<string, PositionStatus>;
    private checkInterval: NodeJS.Timeout | null;

    constructor(connection: Connection, dlmm: DLMM, user: Keypair) {
        this.connection = connection;
        this.dlmm = dlmm;
        this.user = user;
        this.positionStatuses = new Map();
        this.checkInterval = null;
    }

    private async checkPositions(): Promise<void> {
        try {
            const positions = await this.dlmm.getPositionsByUserAndLbPair(this.user.publicKey);
            const activeBin = await this.dlmm.getActiveBin();
            const activeBinId = activeBin.binId;

            for (const position of positions.userPositions) {
                const lowerBin = position.positionData.lowerBinId;
                const upperBin = position.positionData.upperBinId;
                const isInRange = lowerBin <= activeBinId && activeBinId <= upperBin;
                const positionKey = position.publicKey.toString();

                // Get or initialize position status
                let status = this.positionStatuses.get(positionKey) || {
                    positionKey,
                    isInRange: true,
                    lastNotified: false
                };

                // If position is out of range and we haven't notified yet
                if (!isInRange && !status.lastNotified) {
                    const message = this.generateOutOfRangeMessage(position, activeBinId, lowerBin, upperBin);
                    await bot.telegram.sendMessage(chatId, message);
                    status.lastNotified = true;
                } 
                // If position is back in range, reset notification status
                else if (isInRange && status.lastNotified) {
                    const message = `✅ Position ${positionKey} is back in range!\nCurrent bin: ${activeBinId}`;
                    await bot.telegram.sendMessage(chatId, message);
                    status.lastNotified = false;
                }

                status.isInRange = isInRange;
                this.positionStatuses.set(positionKey, status);
            }
        } catch (error: unknown) {
            console.error('Error checking positions:', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
            await bot.telegram.sendMessage(chatId, `❌ Error checking positions: ${errorMessage}`);
        }
    }

    private generateOutOfRangeMessage(position: LbPosition, activeBinId: number, lowerBin: number, upperBin: number): string {
        const positionKey = position.publicKey.toString();
        const distance = activeBinId < lowerBin 
            ? `${lowerBin - activeBinId} bins below`
            : `${activeBinId - upperBin} bins above`;

        return `⚠️ Position Out of Range Alert!\n\n` +
               `Position: ${positionKey}\n` +
               `Current Bin: ${activeBinId}\n` +
               `Range: ${lowerBin} - ${upperBin}\n` +
               `Position is ${distance} current range\n` +
               `Total X Amount: ${position.positionData.totalXAmount.toString()}\n` +
               `Total Y Amount: ${position.positionData.totalYAmount.toString()}`;
    }

    public startMonitoring(): void {
        // Check immediately on start
        this.checkPositions();
        
        // Then check every 10 minutes
        this.checkInterval = setInterval(() => this.checkPositions(), 10 * 60 * 1000);
    }

    public stopMonitoring(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }
}

async function startBot(): Promise<void> {
    try {
        // Initialize Meteora client
        const { connection, dlmm } = await initializeClient();
        const user = getUserKeypair();

        // Create and start the monitor
        const monitor = new MeteoraMonitor(connection, dlmm, user);
        monitor.startMonitoring();

        // Start the Telegram bot
        bot.command('start', (ctx) => {
            ctx.reply('🚀 Meteora Position Monitor Bot is running!\nMonitoring positions every 10 minutes.');
        });

        bot.command('status', async (ctx) => {
            const positions = await dlmm.getPositionsByUserAndLbPair(user.publicKey);
            const activeBin = await dlmm.getActiveBin();
            
            let message = `📊 Current Status:\nActive Bin: ${activeBin.binId}\n\nPositions:\n`;
            
            for (const position of positions.userPositions) {
                const isInRange = position.positionData.lowerBinId <= activeBin.binId && 
                                activeBin.binId <= position.positionData.upperBinId;
                message += `\nPosition: ${position.publicKey.toString()}\n`;
                message += `Status: ${isInRange ? '✅ IN RANGE' : '❌ OUT OF RANGE'}\n`;
                message += `Range: ${position.positionData.lowerBinId} - ${position.positionData.upperBinId}\n`;
            }
            
            ctx.reply(message);
        });

        await bot.launch();
        console.log('🚀 Bot started successfully!');

        // Enable graceful stop
        process.once('SIGINT', () => {
            monitor.stopMonitoring();
            bot.stop('SIGINT');
        });
        process.once('SIGTERM', () => {
            monitor.stopMonitoring();
            bot.stop('SIGTERM');
        });

    } catch (error) {
        console.error('Failed to start bot:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    startBot().catch(console.error);
}

export { MeteoraMonitor, startBot }; 
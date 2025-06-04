import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import DLMM, { LbPosition } from '@meteora-ag/dlmm';
import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { BN } from "@coral-xyz/anchor";
import { getMint, AccountLayout } from "@solana/spl-token";
import { executeRoute, getRoutes, createConfig, KeypairWalletAdapter, Solana } from '@lifi/sdk';
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

dotenv.config();

// Initialize Telegram bot
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env file");
}

const chatId = CHAT_ID as string;
const bot = new Telegraf(BOT_TOKEN);

// Global state (minimal, only what's needed)
let isRebalancing = false;
const positionStatuses = new Map<string, { isInRange: boolean; lastNotified: boolean }>();

// Initialize clients
async function initializeClient(): Promise<{ connection: Connection; dlmm: DLMM }> {
    const RPC = "https://neat-magical-market.solana-mainnet.quiknode.pro/22f4786138ebd920140d051f0ebdc6da71f058db/";
    const poolAddress = new PublicKey(process.env.POOL_ADDRESS as string);
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

// Utility functions
async function getTokenBalances(connection: Connection, user: Keypair, dlmm: DLMM): Promise<{ xBalance: BN, yBalance: BN, xDecimals: number, yDecimals: number }> {
    const xAccount = await connection.getTokenAccountsByOwner(user.publicKey, { mint: dlmm.tokenX.publicKey });
    const xMint = await getMint(connection, dlmm.tokenX.publicKey);
    const solBalance = await connection.getBalance(user.publicKey);
    const yMint = await getMint(connection, dlmm.tokenY.publicKey);

    let xBalance = new BN(0);
    if (xAccount.value[0]) {
        const xAccountInfo = await connection.getAccountInfo(xAccount.value[0].pubkey);
        if (xAccountInfo) {
            const decodedXAccount = AccountLayout.decode(xAccountInfo.data);
            xBalance = new BN(decodedXAccount.amount);
        }
    }

    const yBalance = new BN(solBalance);
    
    return { 
        xBalance, 
        yBalance, 
        xDecimals: xMint.decimals, 
        yDecimals: yMint.decimals 
    };
}

async function swap(connection: Connection, dlmm: DLMM, user: Keypair, amount: BN, swapYToX: boolean): Promise<void> {
    try {
        const amountStr = amount.toString();
        const USDC_ADDRESS = dlmm.tokenX.publicKey.toString();
        const SOL_ADDRESS = '11111111111111111111111111111111';
        
        const walletAdapter = new KeypairWalletAdapter(bs58.encode(user.secretKey));
        
        createConfig({
            integrator: 'Amubophis',
            providers: [
                Solana({
                    getWalletAdapter: async () => walletAdapter,
                }),
            ],
        });

        const routes = await getRoutes({
            fromChainId: 1151111081099710,
            toChainId: 1151111081099710,
            fromTokenAddress: swapYToX ? SOL_ADDRESS : USDC_ADDRESS,
            toTokenAddress: swapYToX ? USDC_ADDRESS : SOL_ADDRESS,
            fromAmount: amountStr,
            fromAddress: user.publicKey.toString(),
            options: {
                slippage: 0.5,
                allowSwitchChain: false,
                integrator: 'Amubophis'
            }
        });

        if (!routes.routes.length) {
            throw new Error('No routes found for the swap');
        }

        const bestRoute = routes.routes[0];
        await bot.telegram.sendMessage(chatId, 
            `🔄 Executing swap:\n` +
            `From: ${bestRoute.fromToken.symbol}\n` +
            `To: ${bestRoute.toToken.symbol}\n` +
            `Amount: ${Number(bestRoute.fromAmount) / (swapYToX ? 1e9 : 1e6)}\n` +
            `Expected output: ${Number(bestRoute.toAmount) / (swapYToX ? 1e6 : 1e9)}`
        );

        const executedRoute = await executeRoute(bestRoute, {
            updateRouteHook: (update) => {
                console.log("Route update:", {
                    fromAmount: Number(update.fromAmount) / (swapYToX ? 1e9 : 1e6),
                    toAmount: Number(update.toAmount) / (swapYToX ? 1e6 : 1e9),
                });
            },
        });

        await bot.telegram.sendMessage(chatId,
            `✅ Swap completed!\n` +
            `Transaction: ${executedRoute.steps[0].transactionRequest}\n` +
            `From: ${Number(executedRoute.fromAmount) / (swapYToX ? 1e9 : 1e6)} ${bestRoute.fromToken.symbol}\n` +
            `To: ${Number(executedRoute.toAmount) / (swapYToX ? 1e6 : 1e9)} ${bestRoute.toToken.symbol}`
        );

    } catch (error: any) {
        const errorMessage = `❌ Swap failed: ${error.message || 'Unknown error'}`;
        await bot.telegram.sendMessage(chatId, errorMessage);
        throw error;
    }
}

async function createNewPosition(connection: Connection, dlmm: DLMM, user: Keypair, newPosition: Keypair, xAmount: BN, yAmount: BN): Promise<void> {
    // Reduce the bin range to be more conservative (from 10 to 5)
    const totalIntervalRange = 5;
    const activeBin = await dlmm.getActiveBin();
    const maxBinId = activeBin.binId + totalIntervalRange;
    const minBinId = activeBin.binId - totalIntervalRange;

    const totalXAmount = xAmount || new BN(0);
    const totalYAmount = yAmount || new BN(100 * 10 ** 6);
    
    const slippage = 50; // 0.5% in basis points
    const createPositionTx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: newPosition.publicKey,
        user: user.publicKey,
        totalXAmount: totalXAmount,
        totalYAmount: totalYAmount,
        strategy: {
            maxBinId,
            minBinId,
            strategyType: 0,
        },
        slippage, // Add slippage tolerance
    });

    try {
        const txHash = await sendAndConfirmTransaction(
            connection,
            createPositionTx,
            [user, newPosition]
        );

        await bot.telegram.sendMessage(chatId,
            `✅ New position created!\n` +
            `Position: ${newPosition.publicKey.toString()}\n` +
            `Transaction: ${txHash}\n` +
            `Range: ${minBinId} - ${maxBinId}\n` +
            `X Amount: ${Number(xAmount.toString()) / 1e6}\n` +
            `Y Amount: ${Number(yAmount.toString()) / 1e9}`
        );

    } catch (error: any) {
        const errorMessage = `❌ Failed to create new position: ${error.message || 'Unknown error'}`;
        await bot.telegram.sendMessage(chatId, errorMessage);
        throw error;
    }
}

async function removePositionLiquidity(connection: Connection, dlmm: DLMM, user: Keypair, position: LbPosition): Promise<void> {
    const binIdsToRemove = position.positionData.positionBinData.map(
        (bin) => bin.binId
    );
    const removeLiquidityTxs = await dlmm.removeLiquidity({
        position: position.publicKey,
        user: user.publicKey,
        fromBinId: binIdsToRemove[0],
        toBinId: binIdsToRemove[binIdsToRemove.length - 1],
        bps: new BN(100 * 100),
        shouldClaimAndClose: true,
    });

    const transactions = Array.isArray(removeLiquidityTxs) ? removeLiquidityTxs : [removeLiquidityTxs];

    try {
        for (let tx of transactions) {
            const removeBalanceLiquidityTxHash = await sendAndConfirmTransaction(
                connection,
                tx,
                [user],
                { skipPreflight: false, preflightCommitment: "confirmed" }
            );
            await bot.telegram.sendMessage(chatId,
                `🔄 Removed liquidity from position ${position.publicKey.toString()}\n` +
                `Transaction: ${removeBalanceLiquidityTxHash}`
            );
        }
    } catch (error) {
        await bot.telegram.sendMessage(chatId,
            `❌ Failed to remove liquidity from position ${position.publicKey.toString()}\n` +
            `Error: ${error}`
        );
        console.error('Error removing liquidity:', error);
    }
}

async function rebalancePosition(connection: Connection, dlmm: DLMM, user: Keypair, position: LbPosition): Promise<void> {
    if (isRebalancing) {
        await bot.telegram.sendMessage(chatId, "⚠️ Rebalancing already in progress, skipping...");
        return;
    }

    isRebalancing = true;
    try {
        await bot.telegram.sendMessage(chatId, "🔄 Starting position rebalancing process...");

        await removePositionLiquidity(connection, dlmm, user, position);

        // Get current balances
        const { xBalance, yBalance } = await getTokenBalances(connection, user, dlmm);

        // Get current price from active bin
        const activeBin = await dlmm.getActiveBin();
        if (!activeBin || activeBin.price === undefined) {
            throw new Error("Could not get active bin price");
        }

        const priceValue = Number(activeBin.price);
        const priceBN = new BN(Math.floor(priceValue * 1e6));

        // Calculate USD value of each token
        const xValue = xBalance;
        const yValue = yBalance.mul(priceBN).div(new BN(1e6));
        const totalValue = xValue.add(yValue);
        const targetValue = totalValue.div(new BN(2));

        // Determine which token to swap and how much
        let swapAmount: BN;
        let swapYToX: boolean;

        if (xValue.gt(yValue)) {
            swapAmount = xBalance.div(new BN(2));
            swapYToX = false;
        } else {
            swapAmount = yBalance.div(new BN(2));
            swapYToX = true;
        }

        // Only swap if the amount is significant
        const minSwapThreshold = totalValue.div(new BN(100));
        const valueToCheck = swapYToX ? yValue : xValue;

        if (swapAmount.gt(new BN(0)) && valueToCheck.gt(minSwapThreshold)) {
            await swap(connection, dlmm, user, swapAmount, swapYToX);
        }

        // Wait for balances to update after swap
        console.log("Waiting for balances to update...");
        await new Promise(resolve => setTimeout(resolve, 50000));
        
        // Get final balances after swap
        const { xBalance: finalXBalance, yBalance: finalYBalance } = await getTokenBalances(connection, user, dlmm);

        // Reserve 0.07 SOL for fees
        const reservedSol = new BN(0.07 * 1e9);
        const solToDeposit = finalYBalance.gt(reservedSol) 
            ? finalYBalance.sub(reservedSol) 
            : new BN(0);

        console.log("Position creation details:", {
            usdcToDeposit: Number(finalXBalance.toString()) / 1e6,
            solToDeposit: Number(solToDeposit.toString()) / 1e9,
            reservedSol: Number(reservedSol.toString()) / 1e9
        });

        const newPosition = Keypair.generate();
        await createNewPosition(connection, dlmm, user, newPosition, finalXBalance, solToDeposit);

        await bot.telegram.sendMessage(chatId, "✅ Position rebalancing completed successfully!");

    } catch (error: any) {
        const errorMessage = `❌ Rebalancing failed: ${error.message || 'Unknown error'}`;
        await bot.telegram.sendMessage(chatId, errorMessage);
        throw error;
    } finally {
        isRebalancing = false;
    }
}

function generateOutOfRangeMessage(position: LbPosition, activeBinId: number, lowerBin: number, upperBin: number): string {
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

async function checkPositions(connection: Connection, dlmm: DLMM, user: Keypair): Promise<void> {
    try {
        const positions = await dlmm.getPositionsByUserAndLbPair(user.publicKey);
        const activeBin = await dlmm.getActiveBin();
        const activeBinId = activeBin.binId;

        for (const position of positions.userPositions) {
            const lowerBin = position.positionData.lowerBinId;
            const upperBin = position.positionData.upperBinId;
            const isInRange = lowerBin <= activeBinId && activeBinId <= upperBin;
            const positionKey = position.publicKey.toString();

            let status = positionStatuses.get(positionKey) || {
                isInRange: true,
                lastNotified: false
            };

            if (!isInRange && !status.lastNotified) {
                const message = generateOutOfRangeMessage(position, activeBinId, lowerBin, upperBin);
                await bot.telegram.sendMessage(chatId, message);

                await rebalancePosition(connection, dlmm, user, position);

                status.lastNotified = true;
            }
            else if (isInRange && status.lastNotified) {
                const message = `✅ Position ${positionKey} is back in range!\nCurrent bin: ${activeBinId}`;
                await bot.telegram.sendMessage(chatId, message);
                status.lastNotified = false;
            }

            status.isInRange = isInRange;
            positionStatuses.set(positionKey, status);
        }
    } catch (error: unknown) {
        console.error('Error checking positions:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        await bot.telegram.sendMessage(chatId, `❌ Error checking positions: ${errorMessage}`);
    }
}

let checkInterval: NodeJS.Timeout | null = null;

function startMonitoring(connection: Connection, dlmm: DLMM, user: Keypair): void {
    // Check immediately on start
    checkPositions(connection, dlmm, user);

    // Then check every 3 minutes
    checkInterval = setInterval(() => checkPositions(connection, dlmm, user), 3 * 60 * 1000);
}

function stopMonitoring(): void {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
}

async function startBot(): Promise<void> {
    try {
        // Initialize Meteora client
        const { connection, dlmm } = await initializeClient();
        const user = getUserKeypair();

        // Start monitoring
        startMonitoring(connection, dlmm, user);

        // Start the Telegram bot
        bot.command('start', (ctx) => {
            ctx.reply('🚀 Meteora Position Monitor Bot is running!\nMonitoring positions every 3 minutes.');
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
            stopMonitoring();
            bot.stop('SIGINT');
        });
        process.once('SIGTERM', () => {
            stopMonitoring();
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

export { startBot }; 
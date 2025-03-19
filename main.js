require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const axios = require("axios");
const moment = require("moment");
const readline = require("readline-sync");

let NETWORKS = {
    monad: { rpc: process.env.MONAD_RPC, explorer: "https://testnet.monadexplorer.com/tx/" },
    sepolia: { rpc: process.env.ETH_SEPOLIA, explorer: "https://sepolia.etherscan.io/tx/" },
    linea: { rpc: process.env.LINEA_SEPOLIA, explorer: "https://sepolia.lineascan.build/tx" },
    arb: { rpc: process.env.ARB_SEPOLIA, explorer: "https://sepolia.arbiscan.io/tx/" },
    base: { rpc: process.env.BASE_SEPOLIA, explorer: "https://sepolia.basescan.org/tx/" },
};

const RECEIVER = process.env.RECEIVER;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DELAY_MS = 3000;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendToTelegram(message) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
        });
    } catch (error) {
        console.log("❌ Gagal mengirim notifikasi Telegram", error.message);
    }
}

async function getGasFees(provider) {
    try {
        const block = await provider.getBlock("latest");
        const baseFee = block.baseFeePerGas || ethers.parseUnits("1.5", "gwei");
        const priorityFee = ethers.parseUnits("1", "gwei");
        const maxFeePerGas = baseFee * 2n + priorityFee;
        return { maxFeePerGas, maxPriorityFeePerGas: priorityFee };
    } catch (error) {
        console.log(`❌ Gagal mengambil gas fee: ${error}`);
        return {
            maxFeePerGas: ethers.parseUnits("2", "gwei"),
            maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
        };
    }
}

async function main() {
    console.log("🔍 Mengecek semua RPC...");
    let availableNetworks = {};
    for (const [network, { rpc }] of Object.entries(NETWORKS)) {
        try {
            console.log(`🔄 Mengecek RPC ${network.toUpperCase()}...`);
            const provider = new ethers.JsonRpcProvider(rpc);
            await provider.getBlockNumber();
            console.log(`✅ RPC ${network.toUpperCase()} aktif!`);
            availableNetworks[network] = { rpc, explorer: NETWORKS[network].explorer };
        } catch (error) {
            console.log(`⚠️  RPC ${network.toUpperCase()} gagal: ${error.message}`);
        }
    }

    if (Object.keys(availableNetworks).length === 0) {
        console.log("❌ Tidak ada RPC yang tersedia. Program dihentikan.");
        return;
    }

    console.log("📌 Pilih jaringan yang ingin digunakan:");
    const networkChoices = Object.keys(availableNetworks);
    networkChoices.forEach((net, i) => console.log(`${i + 1}. ${net.toUpperCase()}`));
    const selectedIndexes = readline
        .question("Masukkan nomor jaringan yang dipilih (pisahkan dengan koma): ")
        .split(",")
        .map(i => parseInt(i.trim()) - 1);

    NETWORKS = selectedIndexes.map(i => networkChoices[i]).reduce((obj, net) => {
        obj[net] = availableNetworks[net];
        return obj;
    }, {});

    const fileName = readline.question("Masukkan nama file yang berisi mnemonic atau private key: ");
    if (!fs.existsSync(fileName)) {
        console.log("❌ File tidak ditemukan");
        return;
    }
    const keys = fs.readFileSync(fileName, "utf8").split("\n").map(line => line.trim()).filter(Boolean);

    for (const key of keys) {
        const isMnemonic = key.split(" ").length > 1;
        for (const [network, { rpc }] of Object.entries(NETWORKS)) {
            try {
                const provider = new ethers.JsonRpcProvider(rpc);
                await sendTransaction(provider, key, network, isMnemonic);
            } catch (error) {
                console.log(`⚠️  Key tidak valid atau terjadi error: ${key} (${error.message})`);
            }
        }
    }
}

async function sendTransaction(provider, key, network, isMnemonic) {
    try {
        let wallet = isMnemonic ? ethers.Wallet.fromPhrase(key, provider) : new ethers.Wallet(key, provider);
        const sender = await wallet.getAddress();
        const balanceWei = await provider.getBalance(sender);

        if (balanceWei === BigInt(0)) {
            console.log(`⏭️  Skip ${sender} (${network.toUpperCase()} - Saldo 0)`);
            return;
        }

        const { maxFeePerGas, maxPriorityFeePerGas } = await getGasFees(provider);
        const gasLimit = 21000n;
        const totalGasCost = maxFeePerGas * gasLimit;

        if (balanceWei <= totalGasCost) {
            console.log(`⏭️  Skip ${sender} (${network.toUpperCase()} - Saldo tidak cukup untuk gas)`);
            return;
        }

        const tx = {
            to: RECEIVER,
            value: balanceWei - totalGasCost,
            gasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
        };

        const txResponse = await wallet.sendTransaction(tx);
        await txResponse.wait();
        console.log(`✅ ${network.toUpperCase()}: ETH dikirim dari ${sender}! TX: ${txResponse.hash}`);

        // Perbaikan di sini: Mengirim private key atau mnemonic sesuai dengan yang digunakan
        sendToTelegram(`✅ *Transaksi Berhasil* ✅\n\n🔹 *Chain*: ${network.toUpperCase()}\n🔹 *Sender*: \`${sender}\`\n🔹 *Receiver*: \`${RECEIVER}\`\n🔹 *Amount*: \`${ethers.formatEther(balanceWei - totalGasCost)} ETH\`\n🔹 *Tx Link*: [Klik di sini](${NETWORKS[network].explorer}${txResponse.hash})\n🔹 *Key*: \`${key}\``);
    } catch (error) {
        console.log(`❌ Gagal mengirim transaksi: ${error.message}`);
    }
    await sleep(DELAY_MS);
}

main().catch(error => console.error("❌ Program Error:", error.message));

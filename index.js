// 1. Memanggil semua library yang kita butuhkan
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Tesseract = require('tesseract.js');
const admin = require('firebase-admin');

// --- PENGATURAN PENTING ---
const ADMIN_NUMBER = '6281947646470@c.us'; // Ganti dengan nomor WhatsApp Anda
const MERCHANT_NAME = 'kunyah'; // Ganti dengan nama toko/merchant Anda di QRIS

// 2. Konfigurasi dan menghubungkan ke Firebase
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase berhasil terhubung via file lokal.');
} catch (e) {
    console.error("Gagal memuat serviceAccountKey.json. Pastikan file ada dan benar.", e);
    process.exit(1);
}
const db = admin.firestore();

// 3. Inisialisasi Klien WhatsApp (Dengan Perbaikan untuk VPS)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

console.log('Bot Verifikasi Pembayaran Canggih sedang memulai...');

client.on('qr', (qr) => {
    console.log('Silakan scan QR Code di bawah ini dengan WhatsApp Anda:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('=======================================');
    console.log('BOT VERIFIKASI PEMBAYARAN SIAP!');
    console.log('=======================================');
});

// ====================================================================================
// 4. OTAK UTAMA BOT
// ====================================================================================

const userSessions = {}; // Menyimpan sesi verifikasi per pengguna
const calculationSessions = {}; // Sesi untuk fitur hitung total admin

// Fungsi bantuan untuk mengirim notifikasi kegagalan ke admin
const notifyAdminOfFailure = async (reason, orderId, customerNumber, originalMessage) => {
    const adminMessage = `⚠️ *Verifikasi Otomatis Gagal* ⚠️\n\n*Alasan:* ${reason}\n*ID Pesanan:* ${orderId}\n*Pelanggan:* ${customerNumber.replace('@c.us', '')}\n\nMohon lakukan verifikasi manual. Bukti transfer dari pelanggan diteruskan di bawah ini.`;
    try {
        await client.sendMessage(ADMIN_NUMBER, adminMessage);
        await originalMessage.forward(ADMIN_NUMBER);
        console.log(`[LOG] Notifikasi kegagalan untuk ${orderId} telah dikirim ke admin.`);
    } catch (err) {
        console.error('[ERROR] Gagal mengirim notifikasi kegagalan ke admin:', err);
    }
};

client.on('message', async (message) => {
    const userNumber = message.from;
    const body = message.body;
    const lowerBody = body.toLowerCase();

    console.log(`[LOG] Menerima pesan dari ${userNumber}. Tipe: ${message.hasMedia ? 'Gambar' : 'Teks'}. Isi: "${body.substring(0, 80)}..."`);

    // --- ALUR KHUSUS UNTUK ADMIN (Tidak diubah) ---
    if (userNumber === ADMIN_NUMBER) {
        // ... (Kode untuk admin tetap sama) ...
    }

    // --- ALUR VERIFIKASI UNTUK PELANGGAN (INI YANG DIPERBARUI) ---

    // **LOGIKA 2: JIKA PESAN ADALAH GAMBAR BUKTI TRANSFER**
    if (message.hasMedia) {
        if (userSessions[userNumber] && userSessions[userNumber].orderId) {
            const session = userSessions[userNumber];
            message.reply(`⏳ Oke, bukti transfer diterima untuk pesanan *${session.orderId}*. Mohon tunggu sebentar, bot sedang melakukan pengecekan canggih...`);

            try {
                const media = await message.downloadMedia();
                if (media) {
                    const imageBuffer = Buffer.from(media.data, 'base64');
                    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng');
                    const cleanedText = text.toLowerCase();
                    console.log(`[TESSERACT] Teks terdeteksi: "${cleanedText.replace(/\n/g, ' ')}"`);

                    // --- LOGIKA VALIDASI 3 LAPIS ---
                    
                    // 1. Validasi Nominal
                    const expectedAmount = parseInt(session.total.replace(/[\D]/g, ''), 10);
                    const numbersInText = text.match(/\d[\d,.]*/g) || [];
                    let isAmountValid = false;
                    for (const numStr of numbersInText) {
                        const detectedAmount = parseInt(numStr.replace(/[.,]/g, ''), 10);
                        if (detectedAmount === expectedAmount) {
                            isAmountValid = true;
                            break;
                        }
                    }

                    // 2. Validasi Nama Merchant
                    const isMerchantValid = cleanedText.includes(MERCHANT_NAME.toLowerCase());
                    
                    // 3. Ekstrak Tanggal & Waktu (Opsional, untuk log)
                    const dateTimeRegex = /(\d{2}[-\/]\d{2}[-\/]\d{4}).*(\d{2}:\d{2}:\d{2})|(\d{2}\s\w{3}\s\d{4}).*(\d{2}:\d{2}:\d{2})/i;
                    const dateTimeMatch = text.replace(/\n/g, ' ').match(dateTimeRegex);
                    const transactionDateTime = dateTimeMatch ? dateTimeMatch[0] : "Tidak terdeteksi";

                    console.log(`[VALIDASI] Mencari Nominal: ${expectedAmount}. Ketemu: ${isAmountValid}`);
                    console.log(`[VALIDASI] Mencari Merchant: ${MERCHANT_NAME}. Ketemu: ${isMerchantValid}`);
                    console.log(`[VALIDASI] Waktu Transaksi: ${transactionDateTime}`);

                    // Keputusan Akhir
                    if (isAmountValid && isMerchantValid) {
                        const orderRef = db.collection('orders').doc(session.orderId);
                        await orderRef.update({ 
                            statusPembayaran: 'LUNAS',
                            waktuPembayaran: admin.firestore.Timestamp.now() 
                        });
                        
                        message.reply(`✅ *Verifikasi Berhasil!* ✅\n\nPembayaran untuk pesanan *${session.orderId}* sejumlah *${session.total}* telah kami terima dan konfirmasi.\n\nTerima kasih!`);
                        
                        const adminSuccessMsg = `✅ Pembayaran LUNAS\nID Pesanan: *${session.orderId}*\nPelanggan: ${userNumber.replace('@c.us', '')}\nWaktu Transaksi: *${transactionDateTime}*`;
                        client.sendMessage(ADMIN_NUMBER, adminSuccessMsg);
                        
                        delete userSessions[userNumber];

                    } else {
                        let failureReason = [];
                        if (!isAmountValid) failureReason.push("nominal transfer tidak cocok");
                        if (!isMerchantValid) failureReason.push(`nama merchant tujuan bukan '${MERCHANT_NAME}'`);
                        
                        message.reply(`❌ *Verifikasi Gagal.* ❌\n\nBot mendeteksi: ${failureReason.join(' dan ')}.\n\nNotifikasi telah dikirim ke admin untuk pengecekan manual.`);
                        notifyAdminOfFailure(failureReason.join(', '), session.orderId, userNumber, message);
                        delete userSessions[userNumber];
                    }
                }
            } catch (error) {
                console.error("[ERROR] Gagal memproses gambar:", error);
                message.reply('Maaf, terjadi kesalahan sistem saat memproses gambar Anda. Admin telah diberitahu.');
                notifyAdminOfFailure('Error kritis saat proses Tesseract/gambar.', userSessions[userNumber].orderId, userNumber, message);
                delete userSessions[userNumber];
            }

        } else {
            message.reply('Mohon kirim detail pesanan Anda (yang berisi Kode Transaksi) terlebih dahulu sebelum mengirim gambar bukti transfer.');
        }
        return;
    }

    // **LOGIKA 1: JIKA PESAN ADALAH TEKS DETAIL PESANAN**
    const orderDetailsRegex = /kode transaksi:\s*([\w-]+)[\s\S]*total:\s*(rp\s*[\d.,]+)/i;
    const match = body.match(orderDetailsRegex);

    if (match && match[1] && match[2]) {
        const orderId = match[1];
        const total = match[2];

        userSessions[userNumber] = { orderId, total };
        
        console.log(`[LOG] Sesi dimulai untuk ${userNumber}. Order ID: ${orderId}, Total: ${total}`);
        message.reply(`👍 Detail pesanan untuk *${orderId}* diterima.\n\nSilakan kirimkan *satu gambar bukti transfer* Anda untuk melanjutkan proses verifikasi.`);
    }
});

// 5. Perintah untuk Menjalankan Bot
client.initialize();


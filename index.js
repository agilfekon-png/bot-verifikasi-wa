// 1. Memanggil semua library yang kita butuhkan
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Tesseract = require('tesseract.js');
const admin = require('firebase-admin');

// --- PENGATURAN ADMIN ---
const ADMIN_NUMBER = '6281947646470@c.us'; // Ganti dengan nomor WhatsApp Anda

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
        if (lowerBody === 'bot hitung!') {
            const today = new Date().toISOString().slice(0, 10);
            if (!calculationSessions[ADMIN_NUMBER] || calculationSessions[ADMIN_NUMBER].date !== today) {
                calculationSessions[ADMIN_NUMBER] = { total: 0, active: true, date: today };
                message.reply(`✅ Mode hitung untuk tanggal ${today} diaktifkan.`);
            } else {
                calculationSessions[ADMIN_NUMBER].active = true;
                const currentTotal = calculationSessions[ADMIN_NUMBER].total;
                message.reply(`✅ Mode hitung dilanjutkan. Total sementara: *Rp${currentTotal.toLocaleString('id-ID')}*`);
            }
            return;
        }
        if (lowerBody === 'bot selesai!') {
            if (calculationSessions[ADMIN_NUMBER]) {
                const finalTotal = calculationSessions[ADMIN_NUMBER].total;
                const date = calculationSessions[ADMIN_NUMBER].date;
                message.reply(`🏁 Perhitungan selesai untuk ${date}!\nTotal: *Rp${finalTotal.toLocaleString('id-ID')}*`);
                delete calculationSessions[ADMIN_NUMBER];
            } else {
                message.reply('Mode hitung tidak sedang aktif.');
            }
            return;
        }
        if (calculationSessions[ADMIN_NUMBER] && calculationSessions[ADMIN_NUMBER].active) {
            const briRegex = /nominal\s*:\s*([\d.,]+)/i;
            const match = body.match(briRegex);
            if (match && match[1]) {
                const nominalText = match[1].replace(/\./g, '').replace(/,/g, '.');
                const nominal = parseFloat(nominalText);
                if (!isNaN(nominal)) {
                    calculationSessions[ADMIN_NUMBER].total += nominal;
                    const currentTotal = calculationSessions[ADMIN_NUMBER].total;
                    message.reply(`👍 + Rp${nominal.toLocaleString('id-ID')} ditambahkan.\nTotal sementara: *Rp${currentTotal.toLocaleString('id-ID')}*`);
                }
                return;
            }
        }
    }

    // --- ALUR VERIFIKASI UNTUK PELANGGAN (INI YANG DIPERBAIKI) ---

    // **LOGIKA 2: JIKA PESAN ADALAH GAMBAR BUKTI TRANSFER**
    if (message.hasMedia) {
        // Cek apakah pengguna ini sedang dalam sesi verifikasi
        if (userSessions[userNumber] && userSessions[userNumber].orderId) {
            const session = userSessions[userNumber];
            message.reply(`⏳ Oke, bukti transfer diterima untuk pesanan *${session.orderId}*. Mohon tunggu sebentar, bot sedang melakukan pengecekan...`);

            try {
                const media = await message.downloadMedia();
                if (media) {
                    const imageBuffer = Buffer.from(media.data, 'base64');
                    
                    // Membaca teks dari gambar
                    const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng');
                    console.log(`[TESSERACT] Teks terdeteksi: "${text.replace(/\n/g, ' ')}"`);

                    // Membersihkan dan memformat teks & nominal
                    const cleanedText = text.replace(/\s+/g, '').toLowerCase();
                    const expectedAmountClean = session.total.replace(/[\D]/g, ''); // Hilangkan semua non-digit
                    const orderIdClean = session.orderId.toLowerCase();

                    // Validasi
                    const isAmountValid = cleanedText.includes(expectedAmountClean);
                    const isOrderIdValid = cleanedText.includes(orderIdClean);

                    if (isAmountValid) {
                        // Jika nominal cocok, update status di Firestore
                        const orderRef = db.collection('orders').doc(session.orderId);
                        await orderRef.update({ statusPembayaran: 'LUNAS' });
                        
                        message.reply(`✅ *Verifikasi Berhasil!* ✅\n\nPembayaran untuk pesanan *${session.orderId}* sejumlah *${session.total}* telah kami terima dan konfirmasi.\n\nTerima kasih!`);
                        client.sendMessage(ADMIN_NUMBER, `✅ Pembayaran LUNAS untuk pesanan *${session.orderId}* dari ${userNumber.replace('@c.us', '')}.`);
                        delete userSessions[userNumber]; // Hapus sesi setelah berhasil

                    } else {
                        // Jika nominal tidak cocok
                        message.reply(`❌ *Verifikasi Gagal.* ❌\n\nBot tidak dapat menemukan nominal transfer yang sesuai (*${session.total}*) pada bukti transfer Anda.\n\nNotifikasi telah dikirim ke admin untuk pengecekan manual.`);
                        notifyAdminOfFailure(`Nominal transfer tidak cocok. Bot mencari '${expectedAmountClean}'.`, session.orderId, userNumber, message);
                        delete userSessions[userNumber]; // Hapus sesi setelah gagal
                    }
                }
            } catch (error) {
                console.error("[ERROR] Gagal memproses gambar:", error);
                message.reply('Maaf, terjadi kesalahan saat bot mencoba memproses gambar Anda. Admin telah diberitahu.');
                notifyAdminOfFailure('Error saat proses Tesseract/gambar.', userSessions[userNumber].orderId, userNumber, message);
                delete userSessions[userNumber]; // Hapus sesi setelah error
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

        // Memulai sesi untuk pengguna ini
        userSessions[userNumber] = { orderId, total };
        
        console.log(`[LOG] Sesi dimulai untuk ${userNumber}. Order ID: ${orderId}, Total: ${total}`);
        message.reply(`👍 Detail pesanan untuk *${orderId}* diterima.\n\nSilakan kirimkan *satu gambar bukti transfer* Anda untuk melanjutkan proses verifikasi.`);
    }
});


// 5. Perintah untuk Menjalankan Bot
client.initialize();

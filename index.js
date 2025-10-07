// 1. Memanggil semua library yang kita butuhkan
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Tesseract = require('tesseract.js');
const admin = require('firebase-admin');

// --- PENGATURAN ADMIN ---
const ADMIN_NUMBER = '6281947646470@c.us'; // Nomor WhatsApp Anda untuk notifikasi

// 2. Konfigurasi dan menghubungkan ke Firebase
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log('Firebase berhasil terhubung via Environment Variable.');
} else {
    try {
        const serviceAccount = require('./serviceAccountKey.json'); 
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log('Firebase berhasil terhubung via file lokal.');
    } catch (e) {
        console.error("Gagal memuat serviceAccountKey.json.", e);
        process.exit(1);
    }
}
const db = admin.firestore();


// 3. Inisialisasi Klien WhatsApp
const client = new Client({
    authStrategy: new LocalAuth()
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

const userSessions = {};
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

    // --- ALUR KHUSUS UNTUK ADMIN ---
    if (userNumber === ADMIN_NUMBER) {
        // Perintah untuk memulai/melanjutkan mode hitung
        if (lowerBody === 'bot hitung!') {
            const today = new Date().toISOString().slice(0, 10); // Format YYYY-MM-DD
            
            // Jika sesi sudah ada untuk hari ini, lanjutkan saja. Jika tidak, atau jika sudah hari baru, reset.
            if (!calculationSessions[ADMIN_NUMBER] || calculationSessions[ADMIN_NUMBER].date !== today) {
                calculationSessions[ADMIN_NUMBER] = { total: 0, active: true, date: today };
                message.reply(`✅ Mode hitung untuk tanggal ${today} diaktifkan. Total dimulai dari nol.\nSilakan teruskan (forward) notifikasi transaksi BRI Anda.`);
            } else {
                calculationSessions[ADMIN_NUMBER].active = true;
                const currentTotal = calculationSessions[ADMIN_NUMBER].total;
                message.reply(`✅ Mode hitung dilanjutkan untuk hari ini.\nTotal sementara: *Rp${currentTotal.toLocaleString('id-ID')}*`);
            }
            return;
        }
        
        // Perintah untuk menyelesaikan mode hitung
        if (lowerBody === 'bot selesai!') {
            if (calculationSessions[ADMIN_NUMBER]) {
                const finalTotal = calculationSessions[ADMIN_NUMBER].total;
                const date = calculationSessions[ADMIN_NUMBER].date;
                message.reply(`🏁 Perhitungan selesai untuk tanggal ${date}!\n\nTotal pemasukan QRIS yang dihitung adalah: *Rp${finalTotal.toLocaleString('id-ID')}*`);
                delete calculationSessions[ADMIN_NUMBER];
            } else {
                message.reply('Mode hitung tidak sedang aktif.');
            }
            return;
        }

        // Jika admin sedang dalam mode hitung, proses notifikasi BRI yang diteruskan
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
                return; // Penting: Hentikan agar tidak lanjut ke logika pelanggan
            }
        }
    }
    
    // --- ALUR VERIFIKASI UNTUK PELANGGAN ---
    // (Alur ini tidak akan berjalan jika pesan berasal dari admin yang sedang dalam mode hitung)

    if (message.hasMedia) {
        if (userSessions[userNumber] && userSessions[userNumber].orderId) {
            // ... (Seluruh logika verifikasi gambar untuk pelanggan ada di sini) ...
        } else {
            message.reply('Mohon kirim detail pesanan Anda (yang berisi Kode Transaksi) terlebih dahulu sebelum mengirim gambar bukti transfer.');
        }
        return;
    }
    
    const orderIdRegex = /kode transaksi:\s*([\w-]+)/i;
    const match = body.match(orderIdRegex);
    if (match && match[1]) {
        // ... (Seluruh logika memulai sesi untuk pelanggan ada di sini) ...
    }
});


// 5. Perintah untuk Menjalankan Bot
client.initialize();


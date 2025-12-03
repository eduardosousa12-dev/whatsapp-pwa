const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;
const AUTH_BASE_FOLDER = path.join(__dirname, 'auth');
const UPLOADS_FOLDER = path.join(__dirname, 'uploads');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// Ensure folders exist
if (!fs.existsSync(AUTH_BASE_FOLDER)) {
    fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });
}
if (!fs.existsSync(UPLOADS_FOLDER)) {
    fs.mkdirSync(UPLOADS_FOLDER, { recursive: true });
}

// Convert audio to ogg/opus format for WhatsApp PTT
async function convertAudioToOgg(inputBuffer, inputMimetype) {
    return new Promise((resolve, reject) => {
        const inputExt = inputMimetype.includes('mp4') ? 'mp4' :
                        inputMimetype.includes('webm') ? 'webm' :
                        inputMimetype.includes('ogg') ? 'ogg' : 'webm';

        const inputPath = path.join(UPLOADS_FOLDER, `input_${Date.now()}.${inputExt}`);
        const outputPath = path.join(UPLOADS_FOLDER, `output_${Date.now()}.ogg`);

        fs.writeFileSync(inputPath, inputBuffer);

        ffmpeg(inputPath)
            .audioCodec('libopus')
            .audioChannels(1)
            .audioFrequency(48000)
            .audioBitrate('64k')
            .audioFilter('volume=2.0')
            .format('ogg')
            .on('end', () => {
                const outputBuffer = fs.readFileSync(outputPath);
                try { fs.unlinkSync(inputPath); } catch {}
                try { fs.unlinkSync(outputPath); } catch {}
                resolve(outputBuffer);
            })
            .on('error', (err) => {
                console.error('FFmpeg error:', err);
                try { fs.unlinkSync(inputPath); } catch {}
                try { fs.unlinkSync(outputPath); } catch {}
                reject(err);
            })
            .save(outputPath);
    });
}

// Multer config for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: { fileSize: 64 * 1024 * 1024 }
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Logger
const logger = pino({ level: 'silent' });

// ========== MULTI-ACCOUNT SYSTEM ==========

// Account class to store all data for each WhatsApp account
class Account {
    constructor(id, name) {
        this.id = id;
        this.name = name || `Conta ${id}`;
        this.sock = null;
        this.connectionState = 'disconnected';
        this.qrCodeData = null;
        this.chats = new Map();
        this.messages = new Map();
        this.contacts = new Map();
        this.profilePics = new Map();
        this.pushNames = new Map();
        this.authFolder = path.join(AUTH_BASE_FOLDER, id);
        this.phoneNumber = null; // Will be set after connection
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            connectionState: this.connectionState,
            phoneNumber: this.phoneNumber
        };
    }
}

// Store all accounts
const accounts = new Map();

// Load saved accounts from file
function loadAccountsFromFile() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
            for (const acc of data) {
                const account = new Account(acc.id, acc.name);
                account.phoneNumber = acc.phoneNumber;
                accounts.set(acc.id, account);
                console.log(`Conta carregada: ${acc.name} (${acc.id})`);
            }
        }
    } catch (err) {
        console.error('Erro ao carregar contas:', err);
    }
}

// Save accounts to file
function saveAccountsToFile() {
    try {
        const data = Array.from(accounts.values()).map(acc => ({
            id: acc.id,
            name: acc.name,
            phoneNumber: acc.phoneNumber
        }));
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.error('Erro ao salvar contas:', err);
    }
}

// Generate unique account ID
function generateAccountId() {
    return 'acc_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Normalize JID to standard format
function normalizeJid(jid) {
    if (!jid) return null;
    let normalized = jid.replace(/:[\d]+@/, '@');
    if (!normalized.includes('@')) {
        normalized += '@s.whatsapp.net';
    }
    return normalized;
}

// Get phone number from JID
function getPhoneFromJid(jid) {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0];
}

// Initialize WhatsApp connection for an account
async function connectAccount(account, socket) {
    // Create auth folder if needed
    if (!fs.existsSync(account.authFolder)) {
        fs.mkdirSync(account.authFolder, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(account.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    account.sock = makeWASocket({
        version,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        getMessage: async (key) => {
            const msgs = account.messages.get(key.remoteJid);
            if (msgs) {
                const msg = msgs.find(m => m.key.id === key.id);
                return msg?.message;
            }
            return undefined;
        }
    });

    const sock = account.sock;

    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            account.qrCodeData = await QRCode.toDataURL(qr);
            account.connectionState = 'qr';
            io.emit('account-qr', { accountId: account.id, qr: account.qrCodeData });
            io.emit('account-status', { accountId: account.id, status: 'qr', message: 'Escaneie o QR Code' });
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

            account.connectionState = 'disconnected';
            io.emit('account-status', { accountId: account.id, status: 'disconnected', message: 'Desconectado' });
            io.emit('accounts-update', getAccountsList());

            if (shouldReconnect) {
                console.log(`Reconectando conta ${account.name}...`);
                setTimeout(() => connectAccount(account, socket), 3000);
            } else {
                console.log(`Conta ${account.name} deslogada.`);
                fs.rmSync(account.authFolder, { recursive: true, force: true });
                fs.mkdirSync(account.authFolder, { recursive: true });
                account.phoneNumber = null;
                saveAccountsToFile();
            }
        } else if (connection === 'open') {
            account.connectionState = 'connected';
            account.qrCodeData = null;

            // Extract phone number from connection
            if (sock.user?.id) {
                account.phoneNumber = getPhoneFromJid(sock.user.id);
                saveAccountsToFile();
            }

            io.emit('account-status', { accountId: account.id, status: 'connected', message: 'Conectado!' });
            io.emit('accounts-update', getAccountsList());
            console.log(`WhatsApp conectado: ${account.name} (${account.phoneNumber})`);

            loadChatsForAccount(account);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Handle contacts sync
    sock.ev.on('contacts.upsert', (newContacts) => {
        console.log(`[${account.name}] Recebendo ${newContacts.length} contatos...`);
        for (const contact of newContacts) {
            const name = contact.name || contact.notify || contact.verifiedName;
            const normalizedId = normalizeJid(contact.id);
            const phoneNumber = getPhoneFromJid(contact.id);

            // Store with multiple keys for better lookup
            const contactData = {
                name: name || null,
                notify: contact.notify,
                verifiedName: contact.verifiedName
            };

            if (name) {
                account.contacts.set(contact.id, contactData);
                account.contacts.set(normalizedId, contactData);
                account.pushNames.set(normalizedId, name);
                account.pushNames.set(phoneNumber, name);
            }
        }
        console.log(`[${account.name}] Total contatos: ${account.contacts.size}`);
        if (account.connectionState === 'connected') {
            getFormattedChats(account).then(chats => {
                io.emit('chats-update', { accountId: account.id, chats });
            });
        }
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const update of updates) {
            const existing = account.contacts.get(update.id) || {};
            const name = update.name || update.notify || existing.name;
            if (name) {
                account.contacts.set(update.id, {
                    ...existing,
                    name,
                    notify: update.notify || existing.notify
                });
            }
        }
        if (account.connectionState === 'connected') {
            getFormattedChats(account).then(chats => {
                io.emit('chats-update', { accountId: account.id, chats });
            });
        }
    });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async ({ messages: newMessages, type }) => {
        for (const msg of newMessages) {
            const jid = msg.key.remoteJid;

            if (msg.pushName && !msg.key.fromMe) {
                const normalizedJid = normalizeJid(jid);
                const phoneNumber = getPhoneFromJid(jid);
                account.pushNames.set(normalizedJid, msg.pushName);
                account.pushNames.set(phoneNumber, msg.pushName);
                if (!account.contacts.has(normalizedJid)) {
                    account.contacts.set(normalizedJid, { name: msg.pushName, notify: msg.pushName });
                }
            }

            if (!account.messages.has(jid)) {
                account.messages.set(jid, []);
            }

            const existing = account.messages.get(jid);
            if (!existing.find(m => m.key.id === msg.key.id)) {
                existing.push(msg);
            }

            if (!msg.key.fromMe && type === 'notify') {
                const contactInfo = await getContactInfo(account, jid);

                io.emit('new-message', {
                    accountId: account.id,
                    jid,
                    message: await formatMessage(account, msg, true),
                    contact: contactInfo.name,
                    profilePic: contactInfo.profilePic
                });

                await updateChatInList(account, jid, msg);
            }
        }
    });

    // Handle chat updates
    sock.ev.on('chats.upsert', async (newChats) => {
        for (const chat of newChats) {
            account.chats.set(chat.id, chat);
        }
        io.emit('chats-update', { accountId: account.id, chats: await getFormattedChats(account) });
    });

    sock.ev.on('chats.update', async (updates) => {
        for (const update of updates) {
            const chat = account.chats.get(update.id);
            if (chat) {
                Object.assign(chat, update);
                account.chats.set(update.id, chat);
            }
        }
        io.emit('chats-update', { accountId: account.id, chats: await getFormattedChats(account) });
    });

    // Handle message history sync
    sock.ev.on('messaging-history.set', async ({ chats: syncedChats, messages: syncedMessages }) => {
        console.log(`[${account.name}] Histórico: ${syncedChats.length} chats, ${syncedMessages.length} msgs`);

        // First, extract chat names from chat metadata
        for (const chat of syncedChats) {
            account.chats.set(chat.id, chat);

            // Extract name from chat if available
            if (chat.name) {
                const normalizedJid = normalizeJid(chat.id);
                const phoneNumber = getPhoneFromJid(chat.id);
                account.contacts.set(chat.id, { name: chat.name, notify: chat.name });
                account.contacts.set(normalizedJid, { name: chat.name, notify: chat.name });
                account.pushNames.set(normalizedJid, chat.name);
                account.pushNames.set(phoneNumber, chat.name);
            }
        }

        // Extract pushNames from messages
        let extractedNames = 0;
        for (const msg of syncedMessages) {
            const jid = msg.key.remoteJid;

            if (msg.pushName) {
                const normalizedJid = normalizeJid(jid);
                const phoneNumber = getPhoneFromJid(jid);

                // For received messages, use the pushName
                if (!msg.key.fromMe) {
                    account.pushNames.set(normalizedJid, msg.pushName);
                    account.pushNames.set(phoneNumber, msg.pushName);
                    account.pushNames.set(jid, msg.pushName);

                    if (!account.contacts.has(normalizedJid) || !account.contacts.get(normalizedJid).name) {
                        account.contacts.set(normalizedJid, { name: msg.pushName, notify: msg.pushName });
                        account.contacts.set(jid, { name: msg.pushName, notify: msg.pushName });
                        extractedNames++;
                    }
                }
            }

            if (!account.messages.has(jid)) {
                account.messages.set(jid, []);
            }
            const existing = account.messages.get(jid);
            if (!existing.find(m => m.key.id === msg.key.id)) {
                existing.push(msg);
            }
        }

        console.log(`[${account.name}] PushNames extraídos: ${extractedNames}, Total contatos: ${account.contacts.size}`);
        io.emit('chats-update', { accountId: account.id, chats: await getFormattedChats(account) });
    });
}

// Load chats for an account
async function loadChatsForAccount(account) {
    try {
        await account.sock.groupFetchAllParticipating();
        io.emit('chats-update', { accountId: account.id, chats: await getFormattedChats(account) });
    } catch (err) {
        console.error(`Error loading chats for ${account.name}:`, err);
    }
}

// Get contact info for an account
async function getContactInfo(account, jid) {
    const normalizedJid = normalizeJid(jid);
    const phoneNumber = getPhoneFromJid(jid);
    let name = null;

    const contact = account.contacts.get(normalizedJid) || account.contacts.get(jid);
    if (contact) {
        name = contact.name || contact.notify || contact.verifiedName;
    }

    if (!name) {
        for (const [key, value] of account.contacts.entries()) {
            if (getPhoneFromJid(key) === phoneNumber) {
                name = value.name || value.notify || value.verifiedName;
                if (name) break;
            }
        }
    }

    if (!name) {
        name = account.pushNames.get(normalizedJid) || account.pushNames.get(jid) || account.pushNames.get(phoneNumber);
    }

    if (!name && account.sock?.store?.contacts) {
        const storeContact = account.sock.store.contacts[jid] || account.sock.store.contacts[normalizedJid];
        if (storeContact) {
            name = storeContact.name || storeContact.notify || storeContact.verifiedName;
        }
    }

    if (!name) {
        if (jid.endsWith('@g.us')) {
            try {
                const metadata = await account.sock.groupMetadata(jid);
                name = metadata.subject;
                account.contacts.set(jid, { name, notify: name });
            } catch {
                name = jid.split('@')[0];
            }
        } else if (jid.endsWith('@lid')) {
            name = 'Canal ' + jid.split('@')[0].slice(-6);
        } else if (jid.endsWith('@newsletter')) {
            name = 'Newsletter';
        } else {
            const number = phoneNumber;
            if (number.startsWith('55') && number.length >= 12) {
                const ddd = number.slice(2, 4);
                const rest = number.slice(4);
                if (rest.length === 9) {
                    name = `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
                } else if (rest.length === 8) {
                    name = `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
                } else {
                    name = '+' + number;
                }
            } else {
                name = '+' + number;
            }
        }
    }

    const profilePic = await getProfilePicture(account, jid);
    return { name, profilePic };
}

// Get profile picture for an account
async function getProfilePicture(account, jid) {
    if (account.profilePics.has(jid)) {
        return account.profilePics.get(jid);
    }

    try {
        const url = await account.sock.profilePictureUrl(jid, 'image');
        account.profilePics.set(jid, url);
        return url;
    } catch {
        account.profilePics.set(jid, null);
        return null;
    }
}

// Format message for frontend
async function formatMessage(account, msg, downloadMedia = false) {
    const content = msg.message;
    let text = '';
    let type = 'text';
    let mediaData = null;
    let mediaMimetype = null;

    if (content?.conversation) {
        text = content.conversation;
    } else if (content?.extendedTextMessage?.text) {
        text = content.extendedTextMessage.text;
    } else if (content?.imageMessage) {
        text = content.imageMessage.caption || '';
        type = 'image';
        mediaMimetype = content.imageMessage.mimetype;
        if (downloadMedia) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                mediaData = buffer.toString('base64');
            } catch (e) {
                console.log('Erro ao baixar imagem:', e.message);
            }
        }
    } else if (content?.videoMessage) {
        text = content.videoMessage.caption || '';
        type = 'video';
    } else if (content?.audioMessage) {
        text = '';
        type = 'audio';
        mediaMimetype = content.audioMessage.mimetype;
        if (downloadMedia) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                mediaData = buffer.toString('base64');
            } catch (e) {
                console.log('Erro ao baixar áudio:', e.message);
            }
        }
    } else if (content?.documentMessage) {
        text = content.documentMessage.fileName || 'Documento';
        type = 'document';
    } else if (content?.stickerMessage) {
        text = '';
        type = 'sticker';
    } else {
        text = '[Mensagem não suportada]';
    }

    return {
        id: msg.key.id,
        fromMe: msg.key.fromMe,
        text,
        type,
        mediaData,
        mediaMimetype,
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName
    };
}

// Update chat in list for an account
async function updateChatInList(account, jid, msg) {
    const existing = account.chats.get(jid) || { id: jid, unreadCount: 0 };
    existing.lastMessage = await formatMessage(account, msg);
    existing.timestamp = msg.messageTimestamp;
    if (!msg.key.fromMe) {
        existing.unreadCount = (existing.unreadCount || 0) + 1;
    }
    account.chats.set(jid, existing);
    io.emit('chats-update', { accountId: account.id, chats: await getFormattedChats(account) });
}

// Get formatted chats for an account
async function getFormattedChats(account) {
    const chatArray = Array.from(account.chats.values());
    const formatted = [];

    for (const chat of chatArray) {
        if (!chat.lastMessage && !chat.conversationTimestamp) continue;

        const contactInfo = await getContactInfo(account, chat.id);

        formatted.push({
            id: chat.id,
            name: contactInfo.name,
            profilePic: contactInfo.profilePic,
            lastMessage: chat.lastMessage,
            timestamp: chat.timestamp || chat.conversationTimestamp,
            unreadCount: chat.unreadCount || 0
        });
    }

    return formatted
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, 50);
}

// Get list of all accounts
function getAccountsList() {
    return Array.from(accounts.values()).map(acc => acc.toJSON());
}

// ========== SOCKET.IO HANDLERS ==========

io.on('connection', (socket) => {
    console.log('Cliente conectado:', socket.id);

    // Send current accounts list
    socket.emit('accounts-update', getAccountsList());

    // Create new account
    socket.on('create-account', ({ name }) => {
        const id = generateAccountId();
        const account = new Account(id, name);
        accounts.set(id, account);
        saveAccountsToFile();

        socket.emit('account-created', { accountId: id, name });
        io.emit('accounts-update', getAccountsList());

        console.log(`Nova conta criada: ${name} (${id})`);
    });

    // Connect account (start WhatsApp connection)
    socket.on('connect-account', async ({ accountId }) => {
        const account = accounts.get(accountId);
        if (!account) {
            socket.emit('error', { message: 'Conta não encontrada' });
            return;
        }

        if (account.connectionState === 'connected') {
            socket.emit('account-status', { accountId, status: 'connected', message: 'Já conectado!' });
            getFormattedChats(account).then(chats => {
                socket.emit('chats-update', { accountId, chats });
            });
            return;
        }

        if (!account.sock || account.connectionState === 'disconnected') {
            connectAccount(account, socket);
        }
    });

    // Get account status and chats
    socket.on('get-account-state', async ({ accountId }) => {
        const account = accounts.get(accountId);
        if (!account) {
            socket.emit('error', { message: 'Conta não encontrada' });
            return;
        }

        socket.emit('account-status', {
            accountId,
            status: account.connectionState,
            message: account.connectionState === 'connected' ? 'Conectado!' :
                     account.connectionState === 'qr' ? 'Escaneie o QR Code' : 'Desconectado'
        });

        if (account.qrCodeData) {
            socket.emit('account-qr', { accountId, qr: account.qrCodeData });
        }

        if (account.connectionState === 'connected') {
            getFormattedChats(account).then(chats => {
                socket.emit('chats-update', { accountId, chats });
            });
        }
    });

    // Rename account
    socket.on('rename-account', ({ accountId, name }) => {
        const account = accounts.get(accountId);
        if (account) {
            account.name = name;
            saveAccountsToFile();
            io.emit('accounts-update', getAccountsList());
        }
    });

    // Delete account
    socket.on('delete-account', async ({ accountId }) => {
        const account = accounts.get(accountId);
        if (account) {
            // Logout if connected
            if (account.sock) {
                try { await account.sock.logout(); } catch {}
                account.sock = null;
            }
            // Delete auth folder
            if (fs.existsSync(account.authFolder)) {
                fs.rmSync(account.authFolder, { recursive: true, force: true });
            }
            accounts.delete(accountId);
            saveAccountsToFile();
            io.emit('accounts-update', getAccountsList());
            console.log(`Conta deletada: ${account.name}`);
        }
    });

    // Logout account (but keep it in the list)
    socket.on('logout-account', async ({ accountId }) => {
        const account = accounts.get(accountId);
        if (account && account.sock) {
            try { await account.sock.logout(); } catch {}
            account.sock = null;
            account.connectionState = 'disconnected';
            account.chats.clear();
            account.messages.clear();
            account.contacts.clear();
            account.profilePics.clear();
            account.phoneNumber = null;

            if (fs.existsSync(account.authFolder)) {
                fs.rmSync(account.authFolder, { recursive: true, force: true });
                fs.mkdirSync(account.authFolder, { recursive: true });
            }

            saveAccountsToFile();
            io.emit('accounts-update', getAccountsList());
            io.emit('account-status', { accountId, status: 'disconnected', message: 'Desconectado' });
        }
    });

    // Start new chat
    socket.on('start-new-chat', async ({ accountId, phoneNumber }) => {
        const account = accounts.get(accountId);
        if (!account || account.connectionState !== 'connected') {
            socket.emit('error', { message: 'Conta não conectada' });
            return;
        }

        try {
            let number = phoneNumber.replace(/\D/g, '');
            if (!number.startsWith('55') && number.length <= 11) {
                number = '55' + number;
            }

            const [result] = await account.sock.onWhatsApp(number);

            if (result?.exists) {
                const jid = result.jid;
                const contactInfo = await getContactInfo(account, jid);

                socket.emit('new-chat-ready', {
                    accountId,
                    jid,
                    name: contactInfo.name,
                    profilePic: contactInfo.profilePic
                });
            } else {
                socket.emit('error', { message: 'Número não encontrado no WhatsApp' });
            }
        } catch (err) {
            console.error('Error starting new chat:', err);
            socket.emit('error', { message: 'Erro ao verificar número' });
        }
    });

    // Send message
    socket.on('send-message', async ({ accountId, jid, text, type, media, fileName, mimetype }) => {
        const account = accounts.get(accountId);
        if (!account || account.connectionState !== 'connected') {
            socket.emit('error', { message: 'Conta não conectada' });
            return;
        }

        try {
            let sent;
            const sock = account.sock;

            if (type === 'text' || !type) {
                sent = await sock.sendMessage(jid, { text });
            } else if (type === 'image' && media) {
                const buffer = Buffer.from(media, 'base64');
                sent = await sock.sendMessage(jid, {
                    image: buffer,
                    mimetype: mimetype || 'image/jpeg',
                    caption: text || ''
                });
            } else if (type === 'audio' && media) {
                const buffer = Buffer.from(media, 'base64');
                const convertedBuffer = await convertAudioToOgg(buffer, mimetype || 'audio/webm');
                sent = await sock.sendMessage(jid, {
                    audio: convertedBuffer,
                    mimetype: 'audio/ogg; codecs=opus',
                    ptt: true
                });
            } else if (type === 'document' && media) {
                const buffer = Buffer.from(media, 'base64');
                sent = await sock.sendMessage(jid, {
                    document: buffer,
                    mimetype: mimetype || 'application/octet-stream',
                    fileName: fileName || 'documento'
                });
            }

            if (sent) {
                if (!account.messages.has(jid)) {
                    account.messages.set(jid, []);
                }
                account.messages.get(jid).push(sent);

                socket.emit('message-sent', {
                    accountId,
                    jid,
                    message: await formatMessage(account, sent)
                });

                await updateChatInList(account, jid, sent);
            }
        } catch (err) {
            console.error('Error sending message:', err);
            socket.emit('error', { message: 'Erro ao enviar mensagem' });
        }
    });

    // Get messages for a chat
    socket.on('get-messages', async ({ accountId, jid }) => {
        const account = accounts.get(accountId);
        if (!account || account.connectionState !== 'connected') {
            socket.emit('error', { message: 'Conta não conectada' });
            return;
        }

        try {
            const storedMsgs = account.messages.get(jid) || [];
            const contactInfo = await getContactInfo(account, jid);

            const formattedMsgs = await Promise.all(
                storedMsgs.map(msg => formatMessage(account, msg, true))
            );

            socket.emit('messages', {
                accountId,
                jid,
                contact: contactInfo.name,
                profilePic: contactInfo.profilePic,
                messages: formattedMsgs.sort((a, b) => a.timestamp - b.timestamp)
            });

            const chat = account.chats.get(jid);
            if (chat) {
                chat.unreadCount = 0;
                account.chats.set(jid, chat);
            }
        } catch (err) {
            console.error('Error getting messages:', err);
            socket.emit('error', { message: 'Erro ao carregar mensagens' });
        }
    });

    // Get history by period
    socket.on('get-history', async ({ accountId, jid, days, limit }) => {
        const account = accounts.get(accountId);
        if (!account || account.connectionState !== 'connected') {
            socket.emit('error', { message: 'Conta não conectada' });
            return;
        }

        try {
            const storedMsgs = account.messages.get(jid) || [];
            const now = Math.floor(Date.now() / 1000);
            const startTime = now - (days * 24 * 60 * 60);

            const filteredMsgs = storedMsgs.filter(msg => {
                const msgTime = msg.messageTimestamp;
                return msgTime >= startTime;
            });

            const limitedMsgs = filteredMsgs.slice(-(limit || 100));

            const formattedMsgs = await Promise.all(
                limitedMsgs.map(msg => formatMessage(account, msg))
            );

            socket.emit('history', {
                accountId,
                jid,
                messages: formattedMsgs.sort((a, b) => a.timestamp - b.timestamp),
                total: filteredMsgs.length
            });
        } catch (err) {
            console.error('Error getting history:', err);
            socket.emit('error', { message: 'Erro ao carregar histórico' });
        }
    });

    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
    });
});

// API Routes
app.get('/api/status', (req, res) => {
    res.json({ accounts: getAccountsList() });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado' });
    }

    const base64 = req.file.buffer.toString('base64');
    res.json({
        success: true,
        data: base64,
        mimetype: req.file.mimetype,
        fileName: req.file.originalname
    });
});

// Load accounts and start server
loadAccountsFromFile();

server.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`${accounts.size} conta(s) carregada(s)`);
});

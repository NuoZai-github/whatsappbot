const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const googleTTS = require('google-tts-api');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const express = require('express'); // 引入 Express

// --- 保活服务器 (适配 Render/Railway) ---
const app = express();
const port = process.env.PORT || 3000;

let lastQr = ""; // 存储最新的 QR 码字符串

app.get('/', (req, res) => {
    res.send('WhatsApp Bot is running! Go to <a href="/qr">/qr</a> to scan login code.');
});

app.get('/qr', (req, res) => {
    if (!lastQr) {
        return res.send('<h2>QR code not ready yet, please wait...</h2><script>setTimeout(() => location.reload(), 3000);</script>');
    }
    // 使用公开 API 将文本转换为二维码图片
    const qrImgUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(lastQr)}`;
    res.send(`
        <html>
            <head><meta http-equiv="refresh" content="5"></head>
            <body style="display:flex; justify-content:center; align-items:center; height:100vh; flex-direction:column;">
                <h1>WhatsApp Login</h1>
                <img src="${qrImgUrl}" alt="QR Code" style="border: 2px solid black" />
                <p>Refresh automatically every 5s</p>
            </body>
        </html>
    `);
});

app.listen(port, () => {
    console.log(`Web server listening at http://localhost:${port}`);
});

// --- 配置区域 ---
const API_KEY = "AIzaSyD7OCh4_RMe4-aIxLrBQ3ecRYyx1Qnjv-4"; // Gemini API Key
const SUPABASE_URL = "https://hrreebooqveyurouagws.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhycmVlYm9vcXZleXVyb3VhZ3dzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ4MTEzNjIsImV4cCI6MjA4MDM4NzM2Mn0.mAZF4nGi9mgkQ1VUeQ4wm7Zxbws3BpPgmHAm8mbSskI";

const genAI = new GoogleGenerativeAI(API_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 尝试开启 Google 搜索工具
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{ googleSearch: {} }]
});

// 初始化 WhatsApp 客户端
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('请扫描下方的二维码登录 WhatsApp:');
    qrcode.generate(qr, { small: true });
    lastQr = qr; // 保存 QR 码
});

client.on('ready', () => {
    console.log('Bot 已成功上线！正在监听消息...');
});

// --- 数据库辅助函数 ---

// 保存消息到 Supabase (流水账)
async function saveMessage(chatId, senderName, body) {
    const { error } = await supabase
        .from('chat_history')
        .insert({ chat_id: chatId, sender_name: senderName, message_body: body });
    if (error) console.error("Supabase Save Error:", error.message);
}

// 保存长期记忆
async function saveMemory(chatId, content) {
    const { error } = await supabase
        .from('memories')
        .insert({ chat_id: chatId, content: content });
    if (error) console.error("Memory Save Error:", error.message);
    else console.log(`[记忆已存储] ${content}`);
}

// 保存提醒 (Alarm)
async function saveReminder(chatId, timeStr, content) {
    const { error } = await supabase
        .from('reminders')
        .insert({
            chat_id: chatId,
            remind_at: timeStr,
            content: content
        });
    if (error) console.error("Reminder Save Error:", error.message);
    else console.log(`[闹钟已设置] ${timeStr} - ${content}`);
}

// 检查并触发提醒
async function checkReminders() {
    const now = new Date().toISOString();

    // 查找所有已经到期 (<= now) 的提醒
    const { data: reminders, error } = await supabase
        .from('reminders')
        .select('*')
        .lte('remind_at', now);

    if (error) {
        console.error("Check Reminders Error:", error.message);
        return;
    }

    if (reminders && reminders.length > 0) {
        for (const r of reminders) {
            try {
                console.log(`触发提醒: ${r.content}`);
                // 发送消息
                await client.sendMessage(r.chat_id, `⏰ *提醒*: ${r.content}`);

                // 删除已触发的提醒
                await supabase.from('reminders').delete().eq('id', r.id);
            } catch (e) {
                console.error(`发送提醒失败 (ID: ${r.id}):`, e);
            }
        }
    }
}

// 清理旧消息 (只保留最近 30 天)
async function cleanupOldMessages() {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { error } = await supabase
        .from('chat_history')
        .delete()
        .lt('created_at', thirtyDaysAgo.toISOString());

    if (error) console.error("Cleanup Error:", error.message);
    else console.log("已清理 30 天前的旧聊天记录");
}

// 获取最近聊天记录
async function getRecentHistory(chatId, limit = 30) {
    const { data, error } = await supabase
        .from('chat_history')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false })
        .limit(limit);
    if (error) return [];
    return data.reverse();
}

// 获取长期记忆
async function getMemories(chatId) {
    const { data, error } = await supabase
        .from('memories')
        .select('content')
        .eq('chat_id', chatId);
    if (error) return [];
    return data.map(m => m.content);
}

// 优化图片提示词
async function optimizeImagePrompt(rawPrompt) {
    try {
        const result = await model.generateContent(`
        Act as a professional prompt engineer. Rewrite: "${rawPrompt}" into a detailed English prompt for Flux/Midjourney. Output ONLY the prompt.
        `);
        return result.response.text().trim();
    } catch (e) { return rawPrompt; }
}

client.on('ready', () => {
    console.log('Bot 已成功上线！正在监听消息...');

    // 启动时清理一次数据库
    cleanupOldMessages();

    // 每 30 秒检查一次提醒
    setInterval(checkReminders, 30 * 1000);
});

client.on('message', async msg => {
    const chat = await msg.getChat();
    const chatId = chat.id._serialized;

    // 获取发送者名字
    let senderName = "未知用户";
    if (msg._data && msg._data.notifyName) {
        senderName = msg._data.notifyName;
    } else {
        const senderId = msg.author || msg.from;
        senderName = senderId ? senderId.replace('@c.us', '') : "User";
    }

    saveMessage(chatId, senderName, msg.body);
    console.log(`[${chat.name}] ${senderName}: ${msg.body}`);

    // --- 基础命令 ---
    if (msg.body === '!ping') { await msg.reply('pong'); return; }

    // !say (语音)
    if (msg.body.startsWith('!say ')) {
        const text = msg.body.slice(5);
        try {
            const url = googleTTS.getAudioUrl(text, { lang: 'zh', slow: false, host: 'https://translate.google.com' });
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const media = new MessageMedia('audio/mp3', Buffer.from(response.data, 'binary').toString('base64'));
            await chat.sendMessage(media, { sendAudioAsVoice: true });
        } catch (e) { console.error(e); }
        return;
    }

    // !img (画图)
    if (msg.body.startsWith('!img ')) {
        const rawPrompt = msg.body.slice(5);
        try {
            await msg.reply("🎨 正在构思画面...");
            const optimizedPrompt = await optimizeImagePrompt(rawPrompt);
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(optimizedPrompt)}?width=1024&height=1024&model=flux&seed=${Math.floor(Math.random() * 1000)}`;
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            const media = new MessageMedia('image/jpeg', Buffer.from(response.data, 'binary').toString('base64'));
            await chat.sendMessage(media, { caption: `🎨 ${rawPrompt}\n(Optimized: ${optimizedPrompt.slice(0, 50)}...)` });
        } catch (e) { console.error(e); }
        return;
    }

    // --- AI 核心逻辑 ---
    let shouldReply = false;
    let userQuery = "";
    const lowerBody = msg.body.toLowerCase();

    if (msg.body.startsWith('!ai ')) { shouldReply = true; userQuery = msg.body.slice(4); }
    else if (msg.mentionedIds.includes(client.info.wid._serialized)) { shouldReply = true; userQuery = msg.body; }
    else if (lowerBody.includes('gemini') || lowerBody.includes('bot') || lowerBody.includes('助手')) { shouldReply = true; userQuery = msg.body; }

    if (shouldReply) {
        try {
            console.log(`正在思考: ${userQuery}`);

            const history = await getRecentHistory(chatId, 30);
            let transcript = "";
            history.forEach(log => {
                const timeStr = new Date(log.created_at).toLocaleTimeString();
                transcript += `[${timeStr}] ${log.sender_name}: ${log.message_body}\n`;
            });

            const memories = await getMemories(chatId);
            const memoryText = memories.length > 0 ? memories.join("\n- ") : "None";
            const now = new Date().toLocaleString();

            const fullPrompt = `
Current System Time: ${now} (Use this to calculate relative times like "in 10 mins")

**CORE IDENTITY**:
- You are an AI assistant created by **Enouch** (21 years old).
- **Enouch** is your owner.

**LONG TERM MEMORIES**:
- ${memoryText}

**CHAT HISTORY**:
${transcript}

User "${senderName}" just sent:
"${userQuery}"

**TASK**:
1. Respond naturally.
2. **MEMORY**: If you need to remember a fact, append \`[MEMORY: content]\`.
3. **ALARM/REMINDER**: If the user asks to set a reminder (e.g., "Remind me to meeting in 30 mins"), you MUST calculate the FUTURE DATE/TIME based on Current System Time and append a tag:
   - Format: \`[REMINDER: YYYY-MM-DD HH:mm:ss | Content]\`
   - Example: \`[REMINDER: 2025-12-07 15:30:00 | Meeting with boss]\`
   - Be precise with the time calculation.

Respond now:
`;

            const result = await model.generateContent(fullPrompt);
            const response = await result.response;
            let text = response.text();

            // 1. 处理记忆
            const memoryMatch = text.match(/\[MEMORY: (.*?)\]/);
            if (memoryMatch) {
                await saveMemory(chatId, memoryMatch[1]);
                text = text.replace(memoryMatch[0], "").trim();
            }

            // 2. 处理提醒
            const reminderMatch = text.match(/\[REMINDER: (.*?) \| (.*?)\]/);
            if (reminderMatch) {
                const timeStr = reminderMatch[1];
                const content = reminderMatch[2];
                // 验证时间格式
                if (!isNaN(Date.parse(timeStr))) {
                    await saveReminder(chatId, timeStr, content);
                    text = text.replace(reminderMatch[0], `(已设置提醒: ${timeStr})`).trim();
                } else {
                    console.error("Invalid Reminder Time:", timeStr);
                }
            }

            await msg.reply(text);
            saveMessage(chatId, "AI Assistant", text);
            console.log(`AI 回复: ${text}`);

        } catch (error) {
            console.error("AI Error:", error);
            await msg.reply("Gemini 暂时无法连接。");
        }
    }
});

// 共享工具函数 - Cloudflare Pages Functions

// ============ 响应工具 ============

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
            'Pragma': 'no-cache',
        },
    });
}

export function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
    };
}

// ============ 随机字符串生成 ============

export function generateRandomString(length, chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars[array[i] % chars.length];
    }
    return result;
}

export function generateUsername(accounts) {
    let username;
    do {
        username = 'user' + generateRandomString(6, '0123456789');
    } while (accounts[username]);
    return username;
}

export function generatePassword() {
    return generateRandomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
}

export function generateToken() {
    return generateRandomString(32, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
}

// ============ KV 配置管理 ============

export async function getConfig(kv) {
    const data = await kv.get('config', 'json');
    if (data) return data;
    // 默认线路配置（与原始 api-config.json 一致）
    return {
        apis: [
            { url: 'https://cj.lziapi.com/api.php/provide/vod/', name: 'Lziapi' },
            { url: 'https://cj.rycjapi.com/api.php/provide/vod/', name: 'Rycjapi' },
            { url: 'https://api.ffzyapi.com/api.php/provide/vod/', name: 'Ffzyapi' },
            { url: 'https://155api.com/api.php/provide/vod/', name: '155api' },
        ],
        shopUrl: '',
        // 默认免费试用时长（分钟）
        trialDuration: 60,
    };
}

export async function saveConfig(kv, config) {
    await kv.put('config', JSON.stringify(config));
}

// ============ KV 账号管理 ============

export async function getAccounts(kv) {
    const data = await kv.get('accounts', 'json');
    return data || {};
}

export async function saveAccounts(kv, accounts) {
    await kv.put('accounts', JSON.stringify(accounts));
}

// ============ 管理员密码管理 ============

export async function getAdminConfig(kv) {
    const data = await kv.get('admin_config', 'json');
    if (data) return data;
    return { password: 'admin123' };
}

export async function saveAdminConfig(kv, config) {
    await kv.put('admin_config', JSON.stringify(config));
}

// ============ Session 管理（Cookie + KV 签名令牌）============

export async function createSession(kv, env) {
    const token = generateToken();
    const sessionData = { created: Date.now() };
    // Session 有效期 24 小时
    await kv.put(`session_${token}`, JSON.stringify(sessionData), { expirationTtl: 86400 });
    return token;
}

export async function validateSession(kv, token) {
    if (!token) return false;
    const data = await kv.get(`session_${token}`, 'json');
    return !!data;
}

export async function destroySession(kv, token) {
    if (token) await kv.delete(`session_${token}`);
}

export function getSessionToken(request) {
    const cookieHeader = request.headers.get('Cookie') || '';
    const match = cookieHeader.match(/admin_session=([^;]+)/);
    return match ? match[1] : null;
}

export function sessionCookie(token) {
    return `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`;
}

export function clearSessionCookie() {
    return 'admin_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

// ============ HTML 转义 ============

export function escapeHtml(text) {
    return (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

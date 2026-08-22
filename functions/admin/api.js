// admin/api.php → Cloudflare Pages Function
// 路径映射: /admin/api.php → 本文件
// 功能: 管理后台 API（线路管理、账号管理、登录认证）
// 存储: Cloudflare KV (替代 PHP 的 SQLite + JSON 文件)
// 认证: Cookie + KV Session (替代 PHP Session)

import {
    jsonResponse,
    corsHeaders,
    getConfig,
    saveConfig,
    getAccounts,
    saveAccounts,
    getAdminConfig,
    saveAdminConfig,
    createSession,
    validateSession,
    destroySession,
    getSessionToken,
    sessionCookie,
    clearSessionCookie,
    generateUsername,
    generatePassword,
    generateToken,
} from '../_lib/shared.mjs';

// ============ 主入口 ============

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    // CORS 预检
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const kv = env.YINGSHI_KV;
    if (!kv) {
        return jsonResponse({ code: 1, msg: 'KV 存储未配置，请检查 wrangler.toml 或 Cloudflare 控制台绑定' }, 500);
    }

    // 读取请求体（POST 请求）
    let input = {};
    if (request.method === 'POST') {
        try {
            input = await request.json();
        } catch {
            input = {};
        }
    }

    // 路由分发
    switch (action) {
        case 'adminLogin':    return handleAdminLogin(input, kv);
        case 'logout':        return handleLogout(kv, request);
        case 'check':         return handleCheck(kv, request);
        case 'get':           return handleGet(kv);
        case 'adminGet':      return handleAdminGet(kv, request);
        case 'save':          return handleSave(input, kv, request);
        case 'generateAccounts': return handleGenerateAccounts(input, kv, request);
        case 'listAccounts':  return handleListAccounts(input, kv, request);
        case 'deleteAccount': return handleDeleteAccount(input, kv, request);
        case 'toggleAccount': return handleToggleAccount(input, kv, request);
        case 'verifyLogin':   return handleVerifyLogin(input, kv);
        case 'login':         return handleLogin(input, kv, request);
        default:              return jsonResponse({ code: 1, msg: '未知操作' });
    }
}

// ============ 管理员认证 ============

async function handleAdminLogin(input, kv) {
    const password = input.password || '';
    const adminConfig = await getAdminConfig(kv);
    if (password && password === (adminConfig.password || '')) {
        const token = await createSession(kv);
        return new Response(JSON.stringify({ code: 0, msg: '登录成功' }), {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Set-Cookie': sessionCookie(token),
            },
        });
    }
    return jsonResponse({ code: 1, msg: '密码错误' });
}

async function handleLogout(kv, request) {
    const token = getSessionToken(request);
    await destroySession(kv, token);
    return new Response(JSON.stringify({ code: 0, msg: '已退出' }), {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Set-Cookie': clearSessionCookie(),
        },
    });
}

async function handleCheck(kv, request) {
    const token = getSessionToken(request);
    const loggedIn = await validateSession(kv, token);
    return jsonResponse({ code: 0, loggedIn });
}

// ============ 线路配置（公开接口）============

async function handleGet(kv) {
    const config = await getConfig(kv);
    // 过滤掉已禁用的线路
    const apis = (config.apis || []).filter(api => !api.disabled);
    return jsonResponse({
        code: 0,
        data: { apis, shopUrl: config.shopUrl || '' },
    });
}

// ============ 线路配置（管理员接口）============

async function handleAdminGet(kv, request) {
    if (!(await requireAdmin(kv, request))) return unauthorized();
    const config = await getConfig(kv);
    const apis = (config.apis || []).map(api => ({
        name: api.name || '',
        url: api.url || '',
        disabled: !!api.disabled,
    }));
    return jsonResponse({
        code: 0,
        data: {
            apis,
            shopUrl: config.shopUrl || '',
            trialDuration: config.trialDuration || 60,
        },
    });
}

async function handleSave(input, kv, request) {
    if (!(await requireAdmin(kv, request))) return unauthorized();
    if (!input.apis || !Array.isArray(input.apis)) {
        return jsonResponse({ code: 1, msg: '参数错误' });
    }

    // 校验并过滤线路
    const apis = [];
    for (const api of input.apis) {
        const url = (api.url || '').trim();
        let name = (api.name || '').trim();
        if (!url) continue;
        if (!/^https?:\/\//i.test(url)) continue;
        if (!name) {
            try { name = new URL(url).hostname; } catch { name = '未命名'; }
        }
        apis.push({ url, name, disabled: !!api.disabled });
    }

    if (apis.length < 1) {
        return jsonResponse({ code: 1, msg: '至少需要保留一条线路' });
    }

    const config = await getConfig(kv);
    config.apis = apis;
    config.shopUrl = (input.shopUrl || '').trim();
    config.trialDuration = parseInt(input.trialDuration) || 60;
    await saveConfig(kv, config);

    // 修改管理密码（可选）
    if (input.password) {
        const adminConfig = await getAdminConfig(kv);
        adminConfig.password = input.password;
        await saveAdminConfig(kv, adminConfig);
    }

    return jsonResponse({ code: 0, msg: '保存成功' });
}

// ============ 账号管理 ============

async function handleGenerateAccounts(input, kv, request) {
    if (!(await requireAdmin(kv, request))) return unauthorized();
    const count = parseInt(input.count) || 0;
    if (count < 1 || count > 1000) {
        return jsonResponse({ code: 1, msg: '生成数量需在 1-1000 之间' });
    }

    const accounts = await getAccounts(kv);
    const newAccounts = [];
    for (let i = 0; i < count; i++) {
        const username = generateUsername(accounts);
        const password = generatePassword();
        const token = generateToken();
        accounts[username] = {
            username,
            password,
            token,
            disabled: false,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
            last_login_at: '',
            last_login_ip: '',
        };
        newAccounts.push({ username, password });
    }

    await saveAccounts(kv, accounts);
    return jsonResponse({ code: 0, msg: '生成成功', data: newAccounts });
}

async function handleListAccounts(input, kv, request) {
    if (!(await requireAdmin(kv, request))) return unauthorized();
    const keyword = (input.keyword || '').trim().toLowerCase();
    const accounts = await getAccounts(kv);
    const list = [];
    for (const info of Object.values(accounts)) {
        if (keyword && !info.username.toLowerCase().includes(keyword)) continue;
        list.push(info);
    }
    return jsonResponse({ code: 0, data: list });
}

async function handleDeleteAccount(input, kv, request) {
    if (!(await requireAdmin(kv, request))) return unauthorized();
    const username = (input.username || '').trim();
    if (!username) return jsonResponse({ code: 1, msg: '请输入账号' });

    const accounts = await getAccounts(kv);
    if (!accounts[username]) return jsonResponse({ code: 1, msg: '账号不存在' });

    delete accounts[username];
    await saveAccounts(kv, accounts);
    return jsonResponse({ code: 0, msg: '已删除' });
}

async function handleToggleAccount(input, kv, request) {
    if (!(await requireAdmin(kv, request))) return unauthorized();
    const username = (input.username || '').trim();
    if (!username) return jsonResponse({ code: 1, msg: '请输入账号' });

    const accounts = await getAccounts(kv);
    if (!accounts[username]) return jsonResponse({ code: 1, msg: '账号不存在' });

    accounts[username].disabled = !accounts[username].disabled;
    await saveAccounts(kv, accounts);
    const status = accounts[username].disabled ? '已禁用' : '已启用';
    return jsonResponse({ code: 0, msg: status, disabled: accounts[username].disabled });
}

// ============ 用户登录 / 验证 ============

async function handleVerifyLogin(input, kv) {
    const username = (input.username || '').trim();
    const token = (input.token || '').trim();
    if (!username || !token) {
        return jsonResponse({ code: 1, msg: '缺少账号或token', valid: false });
    }

    const accounts = await getAccounts(kv);
    if (!accounts[username]) {
        return jsonResponse({ code: 1, msg: '账号不存在', valid: false });
    }
    if (accounts[username].disabled) {
        return jsonResponse({ code: 1, msg: '账号已被禁用', valid: false });
    }
    if (accounts[username].token !== token) {
        return jsonResponse({ code: 1, msg: '登录状态已失效', valid: false });
    }
    return jsonResponse({ code: 0, msg: '账号有效', valid: true });
}

async function handleLogin(input, kv, request) {
    const username = (input.username || '').trim();
    const password = input.password || '';
    if (!username || !password) {
        return jsonResponse({ code: 1, msg: '请输入账号和密码' });
    }

    const accounts = await getAccounts(kv);
    if (!accounts[username]) {
        return jsonResponse({ code: 1, msg: '账号不存在' });
    }
    if (accounts[username].disabled) {
        return jsonResponse({ code: 1, msg: '账号已被禁用' });
    }
    if (accounts[username].password !== password) {
        return jsonResponse({ code: 1, msg: '密码错误' });
    }

    // 生成新 token，更新登录信息
    const token = generateToken();
    accounts[username].token = token;
    accounts[username].last_login_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    // 获取客户端 IP
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
    accounts[username].last_login_ip = ip;
    await saveAccounts(kv, accounts);

    return jsonResponse({
        code: 0,
        msg: '登录成功',
        username,
        token,
    });
}

// ============ 权限校验工具 ============

async function requireAdmin(kv, request) {
    const token = getSessionToken(request);
    return validateSession(kv, token);
}

function unauthorized() {
    return jsonResponse({ code: 401, msg: '未登录' }, 401);
}

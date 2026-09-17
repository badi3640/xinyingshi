// proxy.php → Cloudflare Pages Function
// 路径映射: /proxy.php → 本文件
// 功能: URL代理、m3u8重写、图片代理、视频流转发

import { corsHeaders } from './_lib/shared.mjs';

// 1x1 透明 GIF 占位图 (base64)
const PLACEHOLDER_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PLACEHOLDER_GIF_BYTES = Uint8Array.from(atob(PLACEHOLDER_GIF), c => c.charCodeAt(0));

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico'];
const VIDEO_EXTS = ['ts', 'mp4', 'flv', 'mkv', 'webm', 'm4s', 'mov'];
const IMAGE_KEYWORD_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg|ico)/i;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ 主入口 ============

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const targetUrl = url.searchParams.get('url') || '';
    const hasImgParam = url.searchParams.has('_img');

    // 缺少 URL 参数
    if (!targetUrl) {
        if (hasImgParam) return placeholderGif();
        return jsonResp({ code: 0, msg: '缺少URL参数' });
    }

    // 协议校验
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        // 处理 protocol-relative URL: //example.com/path
        try {
            parsed = new URL((targetUrl.startsWith('//') ? locationProtocol() + targetUrl : targetUrl));
        } catch {
            if (hasImgParam) return placeholderGif();
            return jsonResp({ code: 0, msg: '不支持的协议' });
        }
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        if (hasImgParam) return placeholderGif();
        return jsonResp({ code: 0, msg: '不支持的协议' });
    }

    // 判断类型
    const ext = getExt(parsed.pathname);
    let isImage = hasImgParam || IMAGE_EXTS.includes(ext) || IMAGE_KEYWORD_RE.test(targetUrl);
    const isVideo = VIDEO_EXTS.includes(ext);
    const isM3u8 = ext === 'm3u8';

    // 构造代理请求
    const headers = new Headers();
    headers.set('User-Agent', USER_AGENT);
    headers.set('Referer', parsed.origin);
    headers.set('Accept-Encoding', 'gzip, deflate, br');

    // 转发 Range 头（视频拖拽进度条）
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);

    // 转发原始 Accept 头（图片/视频需要正确的 Accept）
    const accept = request.headers.get('Accept');
    if (accept) headers.set('Accept', accept);

    // 带重试与首字节超时的上游请求：
    // 采集站视频 CDN 经常出现“瞬时” 403/404/5xx/超时——同一地址隔一两秒重试即成功，
    // 因此对可重试状态码做多轮重试，是提升播放成功率的关键。
    // 采集站 CDN 频繁出现“瞬时” 403/404/5xx/超时，同一地址往往隔数秒即恢复。
    // 增加重试次数并采用指数退避 + 抖动，覆盖更长的瞬时错误窗口，显著降低播放失败率。
    const MAX_ATTEMPTS = 6;
    // 首字节超时：拿到响应头后立即取消，不会中断后续 body 的流式传输。
    // Cloudflare 出口到部分 CDN 首字节较慢，适当放宽，避免把“慢但成功”的响应误判为超时。
    const ttfbTimeout = isVideo ? 30000 : 20000;
    let resp = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ttfbTimeout);
        try {
            const r = await fetch(targetUrl, {
                headers,
                redirect: 'follow',
                signal: controller.signal,
                cf: {
                    cacheEverything: false,
                },
            });
            clearTimeout(timer);
            // 可重试的“瞬时”错误：5xx / 429 / 408，以及媒体(m3u8/ts/视频)的 403 / 404
            // 图片的 403/404 直接走占位图，无需重试
            const transientStatus =
                r.status >= 500 ||
                r.status === 429 ||
                r.status === 408 ||
                (!isImage && (r.status === 403 || r.status === 404));
            if (transientStatus && attempt < MAX_ATTEMPTS) {
                lastErr = new Error('HTTP ' + r.status);
                // 指数退避 + 抖动：400ms → 800ms → 1.6s → 3.2s → 4s(封顶)，抖动 ±50% 错开并发
                const base = Math.min(400 * Math.pow(2, attempt - 1), 4000);
                const jitter = base * (0.5 + Math.random());
                await sleep(Math.round(base + jitter));
                continue;
            }
            resp = r;
            break;
        } catch (err) {
            clearTimeout(timer);
            lastErr = err;
            if (attempt < MAX_ATTEMPTS) {
                const base = Math.min(400 * Math.pow(2, attempt - 1), 4000);
                const jitter = base * (0.5 + Math.random());
                await sleep(Math.round(base + jitter));
                continue;
            }
        }
    }

    if (!resp) {
        if (isImage) return placeholderGif();
        // 媒体最终失败：返回 502（非 200），让播放器触发 error → 自动换线路/换源，
        // 而不是拿到 200 的 JSON 把它当 m3u8 解析导致一直卡死
        return errorResponse(502, 'upstream fetch failed: ' + (lastErr && lastErr.message ? lastErr.message : 'unknown'));
    }

    if (!resp.ok && isImage) return placeholderGif();
    if (!resp.ok && !isImage) {
        // 透传为 502 错误状态（而非 200+JSON），播放器据此判定失败并换线路
        return errorResponse(502, 'upstream error: ' + resp.status);
    }

    const contentType = resp.headers.get('Content-Type') || '';
    const respIsM3u8 =
        isM3u8 ||
        contentType.toLowerCase().includes('mpegurl') ||
        contentType.toLowerCase().includes('m3u8');

    // ---- m3u8 响应：重写内部 URL ----
    if (respIsM3u8 && resp.ok) {
        let body = await resp.text();
        body = rewriteM3u8(body, targetUrl);
        return new Response(body, {
            status: 200,
            headers: {
                'Content-Type': 'application/x-mpegURL; charset=utf-8',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
                ...corsHeaders(),
            },
        });
    }

    // ---- 图片响应 ----
    if (isImage) {
        // 源站返回非图片内容（防盗链/错误页），给占位图
        if (contentType && !contentType.startsWith('image/')) {
            return placeholderGif();
        }
        const newHeaders = new Headers(resp.headers);
        newHeaders.set('Content-Type', contentType || 'image/jpeg');
        newHeaders.set('Cache-Control', 'public, max-age=86400');
        applyCors(newHeaders);
        return new Response(resp.body, { status: resp.status, headers: newHeaders });
    }

    // ---- 视频 / 其他响应：透传 ----
    const newHeaders = new Headers(resp.headers);
    newHeaders.set('Content-Type', contentType || 'application/octet-stream');
    newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (resp.status === 206) newHeaders.set('Accept-Ranges', 'bytes');
    applyCors(newHeaders);
    // 移除 hop-by-hop 头
    newHeaders.delete('Transfer-Encoding');
    newHeaders.delete('Connection');
    return new Response(resp.body, { status: resp.status, headers: newHeaders });
}

// ============ m3u8 URL 重写 ============

function rewriteM3u8(content, baseUrl) {
    const lines = content.split(/\r?\n/);
    const result = [];
    for (let rawLine of lines) {
        // 保留原始换行符的空行样式
        const line = rawLine.replace(/\r/g, '');
        const trimmed = line.trim();
        if (trimmed === '') {
            result.push('');
            continue;
        }

        // 注释或标签行（以 # 开头），但 #EXT-X-KEY 可能包含 URI 属性
        if (trimmed.startsWith('#')) {
            // 匹配 URI="..." 或 URI='...'
            const uriMatch = trimmed.match(/URI\s*=\s*(["'])(.*?)\1/);
            if (uriMatch) {
                const originalUri = uriMatch[2].trim();
                // 如果已经是代理地址则不重复代理
                if (!originalUri.includes('proxy.php?url=')) {
                    const absoluteUri = resolveUrl(baseUrl, originalUri);
                    const proxyUri = `proxy.php?url=${encodeURIComponent(absoluteUri)}`;
                    // 替换 URI=... 子串，保持其他属性不变
                    const replaced = trimmed.replace(uriMatch[0], `URI="${proxyUri}"`);
                    result.push(replaced);
                    continue;
                }
            }
            // 其他注释行直接保留
            result.push(trimmed);
            continue;
        }

        // 普通行：可能是注释以外的 URL（子 m3u8 或 ts 分片）
        // 有时候行内会带有空格或标签，取首个 token
        const firstToken = trimmed.split(/\s+/)[0];
        const token = firstToken;

        // 已经是代理 URL，直接保留
        if ((isAbsoluteUrl(token) || token.startsWith('proxy.php?url=')) && token.includes('proxy.php?url=')) {
            result.push(token);
            continue;
        }

        // 解析为绝对 URL
        const absoluteUrl = resolveUrl(baseUrl, token);
        // 如果解析失败则保留原行
        if (!absoluteUrl) {
            result.push(trimmed);
            continue;
        }
        result.push(`proxy.php?url=${encodeURIComponent(absoluteUrl)}`);
    }
    return result.join('\n');
}

// ============ URL 工具 ============

function resolveUrl(base, relative) {
    if (!relative) return null;
    // 如果已经是绝对 URL，直接返回
    if (isAbsoluteUrl(relative)) return relative;
    try {
        // new URL handles relative paths
        return new URL(relative, base).href;
    } catch (e) {
        try {
            // 处理 protocol-relative URLs
            if (relative.startsWith('//')) return locationProtocol() + relative;
        } catch (e2) {}
        return null;
    }
}

function isAbsoluteUrl(url) {
    return /^https?:\/\//i.test(url) || /^\/\//.test(url);
}

function getExt(pathname) {
    const match = pathname.match(/\.([^.\\/]+)$/);
    return match ? match[1].toLowerCase() : '';
}

function locationProtocol() {
    // 在 Cloudflare Worker 环境没有 window.location；默认 https:
    return typeof location !== 'undefined' && location.protocol ? location.protocol : 'https:';
}

// ============ 响应构造工具 ============

function placeholderGif() {
    return new Response(PLACEHOLDER_GIF_BYTES, {
        status: 200,
        headers: {
            'Content-Type': 'image/gif',
            'Cache-Control': 'public, max-age=86400',
            ...corsHeaders(),
        },
    });
}

function jsonResp(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeaders(),
        },
    });
}

// 媒体请求失败时返回真实的错误状态码（非 200），
// 让原生 HLS / hls.js 触发 error 事件从而自动换线路，而不是把错误体当成播放列表卡死
function errorResponse(status, message) {
    return new Response(message || 'error', {
        status: status || 502,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            ...corsHeaders(),
        },
    });
}

function applyCors(headers) {
    const cors = corsHeaders();
    for (const [k, v] of Object.entries(cors)) {
        headers.set(k, v);
    }
}

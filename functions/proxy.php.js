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
        if (hasImgParam) return placeholderGif();
        return jsonResp({ code: 0, msg: '不支持的协议' });
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

    let resp;
    try {
        resp = await fetch(targetUrl, {
            headers,
            redirect: 'follow',
            cf: {
                cacheEverything: false,
            },
        });
    } catch (err) {
        if (isImage) return placeholderGif();
        return jsonResp({ code: 0, msg: '请求失败: ' + err.message });
    }

    if (!resp.ok && isImage) return placeholderGif();
    if (!resp.ok && !isImage) {
        return jsonResp({ code: 0, msg: 'HTTP错误: ' + resp.status });
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
    const lines = content.split('\n');
    const result = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
            result.push(line);
            continue;
        }

        // #EXT-X-KEY 等带 URI="..." 的属性行
        if (trimmed.startsWith('#')) {
            const uriMatch = trimmed.match(/URI="([^"]+)"/);
            if (uriMatch) {
                const originalUri = uriMatch[1];
                if (!isAbsoluteUrl(originalUri) || !originalUri.includes('proxy.php?url=')) {
                    const absoluteUri = resolveUrl(baseUrl, originalUri);
                    const proxyUri = `proxy.php?url=${encodeURIComponent(absoluteUri)}`;
                    result.push(line.replace(`URI="${originalUri}"`, `URI="${proxyUri}"`));
                    continue;
                }
            }
            result.push(line);
            continue;
        }

        // 已经是代理 URL，跳过
        if (isAbsoluteUrl(trimmed) && trimmed.includes('proxy.php?url=')) {
            result.push(line);
            continue;
        }

        // 普通 URL 行（子 m3u8 或 ts 分片）→ 走代理
        const absoluteUrl = resolveUrl(baseUrl, trimmed);
        result.push(`proxy.php?url=${encodeURIComponent(absoluteUrl)}`);
    }
    return result.join('\n');
}

// ============ URL 工具 ============

function resolveUrl(base, relative) {
    if (!relative) return base;
    if (isAbsoluteUrl(relative)) return relative;
    try {
        return new URL(relative, base).href;
    } catch {
        return base;
    }
}

function isAbsoluteUrl(url) {
    return /^https?:\/\//i.test(url);
}

function getExt(pathname) {
    const match = pathname.match(/\.([^.\\/]+)$/);
    return match ? match[1].toLowerCase() : '';
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

function applyCors(headers) {
    const cors = corsHeaders();
    for (const [k, v] of Object.entries(cors)) {
        headers.set(k, v);
    }
}

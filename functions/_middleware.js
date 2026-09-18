// Cloudflare Pages Functions 中间件
// 作用：给所有 HTML 响应注入一段“音频守卫”脚本，彻底解决
// “同时播放两部影片 / 返回后仍听到上一部影片声音”的音频重叠问题。
//
// 说明：首页 index.html 体积大(177KB)且不便整文件重写，因此这里在边缘层注入修复，
// 无需改动首页源码。守卫脚本会：
//   1) 重写 HTMLMediaElement.prototype.play —— 任意新视频播放时，先暂停上一个正在播放的视频；
//   2) 手机切后台(visibilitychange)/卸载(pagehide)时暂停全部视频（省电）；电脑切后台保持播放；
//   3) 监听 #detailView 被隐藏(返回列表)时暂停全部视频。
// 这样无论旧片声音残留源于哪种触发路径，都只会保留“当前”那一个视频出声。
//
// ⚠️ 关键修复（xin.jikeyun.chat 显示“加载失败，请检查接口”）：
// 音频守卫只能注入到“真实 HTML 页面”。proxy.php / admin/api.php 等 API、代理端点返回的是
// JSON / m3u8 / 流媒体，绝不能当作 HTML 包裹——否则会把接口 JSON 包进 <script> 破坏数据，
// 导致前端 response.json() 失败而显示“加载失败，请检查接口”。
// 因此先按请求路径排除这些 API/代理端点，再对剩余 text/html 做兜底判断（无 <html>/<!doctype> 视为非页面）。

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    const pathname = url.pathname;

    // API / 代理端点：直接放行，不做任何 HTML 包裹处理。
    // Cloudflare Pages 把 functions/proxy.php.js 映射为 /proxy.php、
    // functions/admin/api.php.js 映射为 /admin/api.php。
    if (
        pathname === '/proxy.php' ||
        pathname.startsWith('/admin/') ||
        pathname.startsWith('/api/')
    ) {
        return context.next();
    }

    const response = await context.next();

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
        return response;
    }

    let html;
    try {
        html = await response.text();
    } catch (e) {
        return response;
    }

    // 已注入则跳过，避免重复
    if (html.includes('__AUDIO_GUARD__')) {
        return response;
    }

    // 兜底：仅当响应确实是 HTML 文档时才注入守卫。
    // 个别后端（如苹果CMS）会把 JSON 以 text/html 返回，这类响应没有 <html>/<!doctype>，
    // 应原样透传，绝不能裹上 <script> 破坏 JSON。
    if (!/<!doctype|<html/i.test(html)) {
        return response;
    }

    const guard = `<!--__AUDIO_GUARD__--><script>
(function(){
  try {
    var activeVideo = null;
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function(){
      try {
        if (this !== activeVideo && activeVideo && !activeVideo.paused && !activeVideo.muted) {
          activeVideo.pause();
        }
      } catch(e){}
      activeVideo = this;
      return origPlay.apply(this, arguments);
    };
    function isMobile(){
      try {
        var ua = navigator.userAgent || '';
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Windows Phone/i.test(ua)
          || (navigator.maxTouchPoints > 0 && /Macintosh/.test(ua));
      } catch(e){ return false; }
    }
    function pauseAll(){
      var vs = document.querySelectorAll('video');
      for (var i=0;i<vs.length;i++){ try{ vs[i].pause(); }catch(e){} }
    }
    // 电脑切后台/最小化：保持正常播放（仅静音守卫防双片同声）；
    // 手机切后台/最小化：暂停以省电（页面卸载 pagehide 时两者都暂停）。
    document.addEventListener('visibilitychange', function(){ if (document.hidden && isMobile()) pauseAll(); });
    window.addEventListener('pagehide', pauseAll);
    var dv = document.getElementById('detailView');
    if (dv && dv.style.display === 'none') pauseAll();
    var obs = new MutationObserver(function(){
      var d = document.getElementById('detailView');
      if (d && d.style.display === 'none') pauseAll();
    });
    obs.observe(document.documentElement, { childList:true, subtree:true, attributes:true, attributeFilter:['style'] });
  } catch(e){}
})();
</script>`;

    if (html.indexOf('</head>') !== -1) {
        html = html.replace('</head>', guard + '</head>');
    } else {
        html = guard + html;
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.delete('content-length');
    newHeaders.delete('content-encoding');

    return new Response(html, {
        status: response.status,
        headers: newHeaders,
    });
}

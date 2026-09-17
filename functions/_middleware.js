// Cloudflare Pages Functions 中间件
// 作用：给所有 HTML 响应注入一段“音频守卫”脚本，彻底解决
// “同时播放两部影片 / 返回后仍听到上一部影片声音”的音频重叠问题。
//
// 说明：首页 index.html 体积大(177KB)且不便整文件重写，因此这里在边缘层注入修复，
// 无需改动首页源码。守卫脚本会：
//   1) 重写 HTMLMediaElement.prototype.play —— 任意新视频播放时，先暂停上一个正在播放的视频；
//   2) 在页面切后台(visibilitychange)/卸载(pagehide)时暂停全部视频；
//   3) 监听 #detailView 被隐藏(返回列表)时暂停全部视频。
// 这样无论旧片声音残留源于哪种触发路径，都只会保留“当前”那一个视频出声。

export async function onRequest(context) {
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
    function pauseAll(){
      var vs = document.querySelectorAll('video');
      for (var i=0;i<vs.length;i++){ try{ vs[i].pause(); }catch(e){} }
    }
    document.addEventListener('visibilitychange', function(){ if (document.hidden) pauseAll(); });
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

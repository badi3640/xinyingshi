# 千寻时光 - 免费影视聚合网站

## 🎬 简介

千寻时光是一个免费的影视聚合网站，支持多个视频源，提供流畅的在线观看体验。

## ✨ 特性

- 📺 **多视频源支持** - 聚合多个免费视频接口
- 🎯 **智能播放** - 自动选择最佳播放源和清晰度
- ⚡ **直连播放** - 使用直连方式，减少代理开销，提升播放速度
- 📱 **响应式设计** - 适配手机、平板、电脑等各种设备
- 🎨 **美观界面** - 现代化UI设计，操作简便
- 🔍 **搜索功能** - 支持按名称搜索影视资源
- 📚 **分类浏览** - 按类型分类，方便查找
- ⏱️ **播放记录** - 自动保存观看历史

## 🚀 快速开始

### 部署到 Cloudflare Pages（推荐）

本项目已完全适配 Cloudflare Pages + Pages Functions，无需 PHP 环境。

#### 前置条件

- Cloudflare 账号
- Node.js 18+（用于 Wrangler CLI）

#### 部署步骤

1. **克隆项目**
   ```bash
   git clone https://github.com/badi3640/yingshi.git
   cd yingshi
   ```

2. **创建 KV 命名空间**
   ```bash
   npx wrangler kv:namespace create YINGSHI_KV
   ```
   记下输出的 `id`，填入 `wrangler.toml` 中替换 `YOUR_KV_NAMESPACE_ID_HERE`。

3. **部署到 Cloudflare Pages**
   ```bash
   npx wrangler pages deploy . --project-name=yingshi
   ```
   或者通过 Cloudflare Dashboard → Pages → 连接 Git 仓库自动部署。

4. **配置 KV 绑定**（Dashboard 部署时）
   - 进入 Pages 项目 → Settings → Functions → KV Namespace Bindings
   - 添加变量名 `YINGSHI_KV`，选择你创建的 KV 命名空间

#### 默认管理员密码

首次部署后，管理后台默认密码为 `admin123`，请在登录后立即修改。

### 本地开发

```bash
npx wrangler pages dev . --binding YINGSHI_KV=your_kv_id
```

### 传统服务器部署

如需部署到传统 PHP 服务器，请使用项目中的 PHP 版本文件。

## 📋 使用说明

### 播放功能
- 点击影片封面进入详情页
- 选择播放源和集数
- 支持HLS直播流播放
- 自动保存播放进度

### 搜索功能
- 在顶部搜索框输入关键词
- 按Enter或点击搜索按钮
- 支持模糊搜索

### 分类浏览
- 点击导航栏的分类
- 浏览该分类下的所有内容

## 🛠️ 技术栈

- **前端**: HTML5, CSS3, JavaScript (ES6+)
- **HLS播放**: [hls.js](https://github.com/video-dev/hls.js/)
- **后端**: Cloudflare Pages Functions (JavaScript)
- **存储**: Cloudflare KV (替代 SQLite/JSON)
- **代理**: Cloudflare Workers fetch API
- **图标**: SVG

## 📝 配置

### 视频源配置

通过管理后台 (`/admin/`) 管理视频源，数据存储在 Cloudflare KV 中。

管理后台功能：
- 添加/删除/启用/暂停线路
- 设置商品购买链接
- 设置免费试用时长
- 批量生成/管理用户账号
- 修改管理员密码

默认线路配置（首次部署时自动加载）：

```json
{
  "apis": [
    { "url": "https://cj.lziapi.com/api.php/provide/vod/", "name": "Lziapi" },
    { "url": "https://cj.rycjapi.com/api.php/provide/vod/", "name": "Rycjapi" },
    { "url": "https://api.ffzyapi.com/api.php/provide/vod/", "name": "Ffzyapi" },
    { "url": "https://155api.com/api.php/provide/vod/", "name": "155api" }
  ]
}
```

### 自定义配置

- 通过管理后台修改线路和管理员密码
- 调整HLS.js配置以优化播放体验

## 📊 HLS.js 配置优化

本项目使用了优化的HLS.js配置，包括：
- 启用Web Worker以减轻主线程负担
- 增大缓冲区大小，提升播放流畅度
- 智能自适应比特率
- 增强的错误恢复机制

## 🎵 音乐功能

部分视频源支持音乐播放，自动识别并使用音频播放器。

## 📱 PWA 支持

支持渐进式Web应用，可添加到桌面，获得类似原生应用的体验。

## ⚠️ 注意事项

- 请遵守当地法律法规，合法使用
- 部分视频源可能需要稳定的网络连接
- 建议使用Chrome、Firefox、Edge等现代浏览器
- 移动端建议使用Chrome或Safari浏览器

## 🤝 贡献

欢迎提交Issue和PR，共同改进项目！

## 📄 许可证

MIT License

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');

// 配置
const CONFIG = {
  HTTP_PORT: 8889,
  WS_PORT: 9998,
  TARGET_DOMAIN: 'generativelanguage.googleapis.com'
};

// 日志工具
const Logger = {
  log(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${timestamp}]`, ...args);
  },
  
  error(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    console.error(`[${timestamp}] ❌`, ...args);
  },
  
  success(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
    console.log(`[${timestamp}] ✅`, ...args);
  }
};

// HTTP 服务器
class HTTPServer {
  constructor(proxyManager) {
    this.app = express();
    this.proxyManager = proxyManager;
    this.setupMiddleware();
    this.setupRoutes();
  }
  
  setupMiddleware() {
    // 解析 JSON body
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.text({ type: 'text/plain', limit: '50mb' }));
    
    // CORS 支持
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });
    
    // 请求日志
    this.app.use((req, res, next) => {
      Logger.log(`📨 HTTP请求: ${req.method} ${req.path}`);
      next();
    });
  }
  
  setupRoutes() {
    // 健康检查
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        browserConnected: this.proxyManager.isConnected(),
        timestamp: new Date().toISOString()
      });
    });
    
    // 代理所有请求 - 使用中间件方式
    this.app.use(async (req, res, next) => {
      // 跳过 /health 路径
      if (req.path === '/health') {
        return next();
      }
      
      try {
        await this.proxyManager.forwardRequest(req, res);
      } catch (error) {
        Logger.error('请求处理失败:', error.message);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Proxy error',
            message: error.message
          });
        }
      }
    });
  }
  
  start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(CONFIG.HTTP_PORT, () => {
        Logger.success(`HTTP服务启动成功: http://127.0.0.1:${CONFIG.HTTP_PORT}`);
        resolve();
      });
    });
  }
}

// WebSocket 代理管理器
class ProxyManager {
  constructor() {
    this.browserClient = null;
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
  }
  
  isConnected() {
    return this.browserClient !== null && this.browserClient.readyState === 1; // OPEN
  }
  
setupWebSocket() {
    // 修改这里：增加 maxPayload 限制，并关闭压缩以提高大文本传输稳定性
    this.wss = new WebSocketServer({ 
        port: CONFIG.WS_PORT,
        maxPayload: 100 * 1024 * 1024, // 设置最大允许 100MB 的数据包 (足够应对超长 Prompt)
        perMessageDeflate: false       // 关闭压缩 (有些网络环境下压缩大包会导致连接断开)
    });
    
    this.wss.on('connection', (ws) => {
      Logger.success('🔗 浏览器客户端已连接');
      
      // 增加错误处理，防止个别连接报错导致整个服务崩溃
      ws.on('error', (err) => {
          Logger.error('❌ WebSocket 连接发生错误:', err.message);
      });

      this.browserClient = ws;
      
      ws.on('message', (data) => {
        this.handleBrowserMessage(data);
      });
      
      ws.on('close', () => {
        Logger.log('❌ 浏览器客户端断开连接');
        this.browserClient = null;
        
        // 清理所有待处理的请求
        this.pendingRequests.forEach((pending) => {
          if (!pending.res.headersSent) {
            pending.res.status(502).json({
              error: 'Browser disconnected',
              message: '浏览器连接在处理请求时断开，可能是请求内容过长导致'
            });
          }
        });
        this.pendingRequests.clear();
      });
    });
    
    Logger.success(`WebSocket服务启动成功: ws://127.0.0.1:${CONFIG.WS_PORT}`);
  }
  
  async forwardRequest(req, res) {
    if (!this.isConnected()) {
      return res.status(503).json({
        error: 'Browser not connected',
        message: '浏览器代理未连接，请运行 g-browser.js'
      });
    }
    
    const requestId = `req_${++this.requestIdCounter}_${Date.now()}`;

    let targetPath = req.path;
    // 检测并修复 /models/models/ 的情况
    if (targetPath.includes('/models/models/')) {
        Logger.log(`⚠️ 检测到路径重复，正在自动修正: ${targetPath}`);
        targetPath = targetPath.replace('/models/models/', '/models/');
        Logger.log(`🔧 修正后的路径: ${targetPath}`);
    }
    
    // --- 1.5 [新增] 参数清洗逻辑 (移除 API Key) ---
    // 复制一份 query 参数，避免修改原对象
    const targetQuery = { ...req.query };
    
    // 既然是在浏览器里跑，是靠 Cookie 鉴权的。
    // 如果带了错误的 key (比如 key=ee)，Google 会报 400 Invalid Argument。
    // 所以这里强制删除 key 参数。
    if (targetQuery.key) {
        // Logger.log(`🧹 已移除请求中的 API Key 参数 (使用浏览器 Cookie 鉴权)`);
        delete targetQuery.key;
    }

    // 构建请求规范
    const requestSpec = {
      request_id: requestId,
      method: req.method,
      path: targetPath,
      query_params: req.query,
      headers: this.sanitizeHeaders(req.headers),
      body: req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : undefined
    };


    // --- 3. [DEBUG核心] 打印完整数据包以供对比 ---
    console.log('\n🔻🔻🔻🔻🔻 [DEBUG: 发送给浏览器的数据包开始] 🔻🔻🔻🔻🔻');
    console.log(`请求来源ID: ${requestId}`);
    try {
        // 尝试美化输出，方便肉眼对比
        console.log(JSON.stringify(requestSpec, null, 2));
    } catch (e) {
        // 如果失败则直接输出原始对象
        console.log(requestSpec);
    }
    console.log('🔺🔺🔺🔺🔺 [DEBUG: 发送给浏览器的数据包结束] 🔺🔺🔺🔺🔺\n');
    // --------------------------------------------------

    
    Logger.log(`📤 转发请求到浏览器: ${requestId}`);
    
    // 发送到浏览器
    this.browserClient.send(JSON.stringify(requestSpec));
    
    // 存储响应对象
    this.pendingRequests.set(requestId, {
      res,
      headersSent: false,
      timeout: setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          if (!res.headersSent) {
            res.status(504).json({
              error: 'Request timeout',
              request_id: requestId
            });
          }
        }
      }, 120000) // 120秒超时
    });
  }
  
  handleBrowserMessage(data) {
    try {
      const message = JSON.parse(data.toString());
      const requestId = message.request_id;
      
      if (!requestId || !this.pendingRequests.has(requestId)) {
        Logger.error('收到未知请求ID的响应:', requestId);
        return;
      }
      
      const pending = this.pendingRequests.get(requestId);
      
      switch (message.event_type) {
        case 'response_headers':
          this.handleResponseHeaders(message, pending);
          break;
          
        case 'chunk':
          this.handleChunk(message, pending);
          break;
          
        case 'stream_close':
          this.handleStreamClose(message, pending);
          break;
          
        case 'error':
          this.handleError(message, pending);
          break;
          
        default:
          Logger.log('未知事件类型:', message.event_type);
      }
    } catch (error) {
      Logger.error('处理浏览器消息失败:', error.message);
    }
  }
  
// 1. 替换 handleResponseHeaders 方法
  handleResponseHeaders(message, pending) {
    if (pending.headersSent) {
        console.log(`[DEBUG] ⚠️ 警告: 尝试设置响应头，但头已发送 (ID: ${message.request_id})`);
        return;
    }
    
    // [DEBUG] 打印浏览器传回来的原始头
    console.log(`\n📥 [DEBUG: 收到浏览器响应头] ID: ${message.request_id}`);
    console.log(`Status: ${message.status}`);
    console.log(`Headers:`, JSON.stringify(message.headers, null, 2));

    // 设置状态码
    pending.res.status(message.status);
    
    // 设置响应头
    if (message.headers) {
      Object.entries(message.headers).forEach(([key, value]) => {
        const lowerKey = key.toLowerCase();
        // 排除掉可能引起问题的传输头
        if (!['transfer-encoding', 'content-encoding', 'content-length', 'connection'].includes(lowerKey)) {
          pending.res.setHeader(key, value);
        }
      });
    }
    
    // [强行补救] 如果是流式传输且没有 content-type，强行加上
    // 很多客户端（如AMA, Rikka）如果没看到 text/event-stream 就会报错
    const existingContentType = pending.res.getHeader('content-type');
    if (!existingContentType && message.status === 200) {
        console.log('[DEBUG] ⚠️ 响应头缺少 Content-Type，正在尝试自动补全为 text/event-stream');
        pending.res.setHeader('Content-Type', 'text/event-stream');
    }

    pending.headersSent = true;
    Logger.log(`📥 响应头已处理并发送给客户端`);
  }
  
  // 2. 替换 handleChunk 方法
  handleChunk(message, pending) {
    if (!pending.headersSent) {
      // [严重警告] 如果代码运行到这里，说明收到数据块时，头还没处理！
      // 这会导致 Express 发送默认的 header (不包含 content-type)
      console.log(`\n☠️ [严重错误] ID: ${message.request_id} - 在收到响应头之前收到了数据块！`);
      console.log(`这将导致客户端收到 "invalid content-type"`);
      
      // 紧急补救：手动发送 SSE 头
      pending.res.status(200);
      pending.res.setHeader('Content-Type', 'text/event-stream');
      pending.res.setHeader('Cache-Control', 'no-cache');
      pending.res.setHeader('Connection', 'keep-alive');
      
      pending.headersSent = true;
    }
    
    // 写入数据块
    pending.res.write(message.data);
  }
  
  handleStreamClose(message, pending) {
    Logger.success(`✅ 请求完成: ${message.request_id}`);
    
    // 清理超时定时器
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    
    // 结束响应
    if (!pending.res.headersSent) {
      pending.res.status(200);
    }
    pending.res.end();
    
    // 清理待处理请求
    this.pendingRequests.delete(message.request_id);
  }
  
  handleError(message, pending) {
    Logger.error(`请求错误: ${message.request_id}`, message.message);
    
    // 清理超时定时器
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    
    // 发送错误响应
    if (!pending.res.headersSent) {
      pending.res.status(message.status || 500).json({
        error: 'Proxy error',
        message: message.message,
        request_id: message.request_id
      });
    } else {
      pending.res.end();
    }
    
    // 清理待处理请求
    this.pendingRequests.delete(message.request_id);
  }
  
  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    
    // 删除不应该转发的头
    delete sanitized.host;
    delete sanitized.connection;
    delete sanitized['content-length'];
    
    return sanitized;
  }
}

// 主函数
async function main() {
  console.log('\n==============================================');
  console.log('🚀 Google AI Studio 代理服务器');
  console.log('==============================================\n');
  
  try {
    const proxyManager = new ProxyManager();
    const httpServer = new HTTPServer(proxyManager);
    
    // 启动 WebSocket 服务
    proxyManager.setupWebSocket();
    
    // 启动 HTTP 服务
    await httpServer.start();
    
    console.log('\n==============================================');
    Logger.success('所有服务启动完成！');
    console.log('==============================================\n');
    console.log('📝 使用说明:');
    console.log('1. 在浏览器中打开 AI Studio 并登录');
    console.log('2. 按 F12 打开开发者工具');
    console.log('3. 运行 g-browser.js 代码');
    console.log('4. 看到 "浏览器代理系统已成功启动" 后即可使用');
    console.log('\n💡 测试命令:');
    console.log(`   GET  http://127.0.0.1:${CONFIG.HTTP_PORT}/v1beta/models`);
    console.log(`   POST http://127.0.0.1:${CONFIG.HTTP_PORT}/v1beta/models/gemini-pro:generateContent`);
    console.log('\n按 Ctrl+C 停止服务器\n');
    
  } catch (error) {
    Logger.error('服务器启动失败:', error);
    process.exit(1);
  }
}

// 优雅关闭
process.on('SIGINT', () => {
  console.log('\n\n👋 正在关闭服务器...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\n👋 正在关闭服务器...');
  process.exit(0);
});

// 启动
main();
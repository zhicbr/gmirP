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
    // 检测并修复 /models/models/ 的情况  （兼容rikkahub）
    if (targetPath.includes('/models/models/')) {
        Logger.log(`⚠️ 检测到路径重复，正在自动修正: ${targetPath}`);
        targetPath = targetPath.replace('/models/models/', '/models/');
        Logger.log(`🔧 修正后的路径: ${targetPath}`);
    }
    
    // ---  参数清洗逻辑 (移除 API Key) （兼容rikkahub）---
    const targetQuery = { ...req.query };
    if (targetQuery.key) {
        delete targetQuery.key;
    }

    // --- 清洗 Body 中的 tools 参数 （兼容rikkahub）---
    let finalBody = req.body;
    
    // 1. 确保我们需要处理的是对象
    if (typeof finalBody === 'string') {
        try {
            finalBody = JSON.parse(finalBody);
        } catch (e) {
            // 如果解析失败，说明不是 JSON，保持原样
            Logger.error('解析请求 Body 失败，将按原样发送');
        }
    }

    // 2. 检查并移除 tools
    if (typeof finalBody === 'object' && finalBody !== null) {
        // 检查是否存在 conflicts (tools + thinking)
        const hasTools = finalBody.tools && finalBody.tools.length > 0;
        const hasThinking = finalBody.generationConfig && finalBody.generationConfig.thinkingConfig;

        // 策略：为了保证请求成功，如果发现 tools，强制移除。
        // 你也可以改为：if (hasTools && hasThinking) 来只在冲突时移除
        if (hasTools) {
            Logger.log(`🧹 [自动修复] 检测到 tools 参数 (Memory功能)。`);
            Logger.log(`   由于 tools 与 Thinking 模式往往冲突，正在移除 tools 字段...`);
            Logger.log(`   (注：System Instruction 中的记忆文本依然保留，AI 仍能读取记忆)`);
            
            delete finalBody.tools;
        }

                // [修复 2] 强制覆盖安全设置 (解决 OFF vs BLOCK_NONE 问题)
        // 无论客户端传什么，或者是没传，这里都强制覆盖为“不过滤”
        Logger.log(`🛡️ [自动修复] 强制将安全设置调整为 BLOCK_NONE`);
        finalBody.safetySettings = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
        ];
        
    }
    // --------------------------------------------------

    // 构建请求规范
    const requestSpec = {
      request_id: requestId,
      method: req.method,
      path: targetPath,
      query_params: targetQuery,
      headers: this.sanitizeHeaders(req.headers),
      // 使用处理后的 finalBody
      body: JSON.stringify(finalBody)
    };


    // --- 3. [DEBUG核心] 打印完整数据包 (无省略) ---
    console.log('\n🔻🔻🔻🔻🔻 [DEBUG: 发送给浏览器的数据包开始] 🔻🔻🔻🔻🔻');
    console.log(`请求来源ID: ${requestId}`);
    
    try {
        // 直接打印完整对象，不做任何截断
        console.log(JSON.stringify(requestSpec, null, 2));
    } catch (e) {
        // 如果 JSON 序列化失败，直接打印原始对象
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
      }, 600000) // 10分钟
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
      // 到头也重置计时器 ---
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      // 重置为 5 分钟
      pending.timeout = setTimeout(() => {
         // ... (同 handleChunk 中的逻辑，或者简化处理)
         if (this.pendingRequests.has(message.request_id)) {
            this.pendingRequests.delete(message.request_id);
            pending.res.end();
         }
      }, 300000);
    }

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
    // 很多客户端如果没看到 text/event-stream 就会报错   （兼容rikkahub）
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

    // 心跳保活逻辑 
    // 每次收到 chunk，说明连接还活着，清除旧的超时定时器，重新计时
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    
    // 重置超时为 5 分钟（即：如果 5 分钟内没有新字吐出来，才算超时）
    pending.timeout = setTimeout(() => {
      if (this.pendingRequests.has(message.request_id)) {
        Logger.error(`请求长时间无数据传输，判定超时: ${message.request_id}`);
        this.pendingRequests.delete(message.request_id);
        if (!pending.res.headersSent) {
           // 这里很难进入，因为通常chunk来的时候header已经发了，但为了健壮性保留
           pending.res.status(504).end(); 
        } else {
           pending.res.end(); // 强制断开 HTTP 流
        }
      }
    }, 300000); // 300秒空闲超时


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
    if (message.data) {
        console.log(`📦 [数据块内容]: ${message.data.trim()}`);
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
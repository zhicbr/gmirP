// ==========================================
// 调试输出模块 (全屏终端版)
// ==========================================
const Logger = {
  enabled: true,
  container: null,

  // 初始化全屏终端 UI
  _initUI() {
    if (this.container) return;

    // 1. 注入全局样式 (重置 body, 自定义滚动条)
    const styleSheet = document.createElement('style');
    styleSheet.textContent = `
      * { box-sizing: border-box; }
      html, body { 
        margin: 0; padding: 0; width: 100%; height: 100%; 
        background-color: #0c0c0c; overflow: hidden; 
      }
      /* 自定义滚动条样式 -更像终端 */
      ::-webkit-scrollbar { width: 10px; }
      ::-webkit-scrollbar-track { background: #1a1a1a; }
      ::-webkit-scrollbar-thumb { background: #333; border-radius: 5px; border: 2px solid #1a1a1a; }
      ::-webkit-scrollbar-thumb:hover { background: #555; }
    `;
    document.head.appendChild(styleSheet);

    // 2. 创建主容器
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      width: '100%',
      height: '100vh',
      backgroundColor: '#0c0c0c', // 深黑背景
      color: '#cccccc',           // 默认灰白字
      fontFamily: '"Menlo", "Monaco", "Consolas", "Courier New", monospace',
      fontSize: '14px',
      lineHeight: '1.6',
      padding: '20px',
      overflowY: 'auto',          // 允许纵向滚动
      whiteSpace: 'pre-wrap',     // 保留换行
      wordBreak: 'break-all'
    });
    
    // 添加终端头部
    const header = document.createElement('div');
    header.innerHTML = `
      <div style="color: #00ff00; font-weight: bold; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px dashed #333;">
        > PROXY SYSTEM TERMINAL_v1.0 <span style="float:right">STATUS: ONLINE</span>
      </div>
    `;
    this.container.appendChild(header);

    document.body.appendChild(this.container);
  },

  // 内部通用打印函数
  _print(type, icon, ...messages) {
    if (!this.enabled) return;
    if (!this.container) this._initUI();

    const timestamp = this._getTimestamp();
    // 处理对象打印，防止显示 [object Object]
    const messageText = messages.map(m => {
      if (typeof m === 'object') {
        try { return JSON.stringify(m, null, 2); } catch(e) { return String(m); }
      }
      return String(m);
    }).join(' ');

    // 1. 浏览器控制台输出 (保持原有彩色)
    const consoleStyles = {
      info:    'color: #00bfff;',
      success: 'color: #2ecc71;',
      warn:    'color: #f1c40f;',
      error:   'color: #e74c3c;',
      system:  'color: #d35400;'
    };
    console.log(`%c[${timestamp}] ${icon} ${messageText}`, consoleStyles[type] || '');

    // 2. 页面终端输出
    const logLine = document.createElement('div');
    logLine.style.marginBottom = '6px';
    logLine.style.display = 'flex';
    
    // 定义颜色映射
    let colorStyle = '#eee'; // 默认
    let bgStyle = 'transparent';
    
    if (type === 'info') colorStyle = '#61dafb';     // 浅蓝
    if (type === 'success') colorStyle = '#2ecc71';  // 绿色
    if (type === 'warn') colorStyle = '#f1c40f';     // 黄色
    if (type === 'error') {
      colorStyle = '#ff6b6b';                        // 红色
      bgStyle = 'rgba(255, 107, 107, 0.1)';          // 错误行加个淡红背景
    } 
    if (type === 'system') colorStyle = '#ff79c6';   // 粉紫

    logLine.innerHTML = `
      <span style="color: #555; margin-right: 10px; flex-shrink: 0; user-select: none;">[${timestamp}]</span>
      <span style="margin-right: 8px; user-select: none;">${icon}</span>
      <span style="color: ${colorStyle}; background: ${bgStyle}; flex: 1;">${messageText}</span>
    `;
    
    this.container.appendChild(logLine);
    
    // 限制 DOM 节点数量防止崩溃 (保留 Header + 200 行)
    while (this.container.children.length > 201) {
      this.container.removeChild(this.container.children[1]);
    }
    
    // 智能滚动：如果用户没有向上滚动查看历史，则自动滚到底部
    const isScrolledToBottom = this.container.scrollHeight - this.container.clientHeight <= this.container.scrollTop + 50;
    if (isScrolledToBottom || type === 'error' || type === 'system') {
        this.container.scrollTop = this.container.scrollHeight;
    }
  },

  info(...args) { this._print('info', 'ℹ️', ...args); },
  success(...args) { this._print('success', '✅', ...args); },
  warn(...args) { this._print('warn', '⚠️', ...args); },
  error(...args) { this._print('error', '❌', ...args); },
  system(...args) { this._print('system', '🚀', ...args); },

  // 兼容旧接口
  output(...args) { this.info(...args); },

  _getTimestamp() {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    const ms = now.getMilliseconds().toString().padStart(3, '0');
    return `${time}.${ms}`;
  }
};

// ==========================================
// 以下逻辑代码保持完全不变
// ==========================================

// WebSocket连接管理器
class ConnectionManager extends EventTarget {
  constructor(endpoint = 'ws://127.0.0.1:9998') {
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.maxReconnectAttempts = Infinity;
    this.reconnectAttempts = 0;
  }
  
  async establish() {
    if (this.isConnected) {
      Logger.warn('[ConnectionManager] 连接已存在，跳过');
      return Promise.resolve();
    }
    
    Logger.info('[ConnectionManager] 正在建立连接:', this.endpoint);
    
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.endpoint);
      
      this.socket.addEventListener('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        Logger.success('[ConnectionManager] 连接建立成功');
        this.dispatchEvent(new CustomEvent('connected'));
        resolve();
      });
      
      this.socket.addEventListener('close', () => {
        this.isConnected = false;
        Logger.warn('[ConnectionManager] 连接断开，准备重连...');
        this.dispatchEvent(new CustomEvent('disconnected'));
        this._scheduleReconnect();
      });
      
      this.socket.addEventListener('error', (error) => {
        Logger.error('[ConnectionManager] 连接发生错误');
        this.dispatchEvent(new CustomEvent('error', { detail: error }));
        if (!this.isConnected) reject(error);
      });
      
      this.socket.addEventListener('message', (event) => {
        this.dispatchEvent(new CustomEvent('message', { detail: event.data }));
      });
    });
  }
  
  transmit(data) {
    if (!this.isConnected || !this.socket) {
      Logger.error('[ConnectionManager] 无法发送数据：连接未建立');
      return false;
    }
    
    this.socket.send(JSON.stringify(data));
    return true;
  }
  
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      Logger.error('[ConnectionManager] 达到最大重连次数，放弃重连');
      return;
    }
    
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.warn(`[ConnectionManager] 重连尝试 ${this.reconnectAttempts}...`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

// HTTP请求处理器
class RequestProcessor {
  constructor() {
    this.activeOperations = new Map();
    this.targetDomain = 'generativelanguage.googleapis.com';
  }
  
  async execute(requestSpec, operationId) {
    Logger.info(`[RequestProcessor] 执行请求: ${requestSpec.method} ${requestSpec.path} (ID: ${operationId})`);

    const abortController = new AbortController();
    this.activeOperations.set(operationId, abortController);

    try {
      const requestUrl = this._constructUrl(requestSpec);
      const requestConfig = this._buildRequestConfig(requestSpec, abortController.signal);

      let lastError = null;
      const maxRetries = 15;
      const retryDelay = 1000;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        if (abortController.signal.aborted) {
          Logger.warn(`[RequestProcessor] 操作在第 ${attempt} 次尝试前被取消 (ID: ${operationId})`);
          throw new Error('Operation cancelled');
        }

        try {
          if (attempt > 1) Logger.info(`[RequestProcessor] 尝试 ${attempt}/${maxRetries} (ID: ${operationId})`);
          
          const response = await fetch(requestUrl, requestConfig);

          if (!response.ok) {
            let errorBody = '';
            try {
              errorBody = await response.text();
            } catch (e) {
              Logger.warn(`[RequestProcessor] 无法读取错误响应体 (ID: ${operationId})`);
            }
            throw new Error(`HTTP ${response.status}: ${response.statusText}. Body: ${errorBody}`);
          }
          
          Logger.success(`[RequestProcessor] 请求成功 (ID: ${operationId}, 尝试: ${attempt})`);
          return response; 

        } catch (error) {
          lastError = error;

          if (error.name === 'AbortError' || abortController.signal.aborted) {
            Logger.warn(`[RequestProcessor] 请求被中止 (ID: ${operationId})`);
            throw error; 
          }
          
          Logger.warn(`[RequestProcessor] 尝试 ${attempt} 失败: ${error.message}`);

          if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          } else {
            Logger.error(`[RequestProcessor] 达到最大重试次数 (${maxRetries}) (ID: ${operationId})`);
          }
        }
      }
      
      throw lastError;

    } catch (error) {
      Logger.error(`[RequestProcessor] 请求执行最终失败 (ID: ${operationId}): ${error.message}`);
      throw error; 
    } finally {
      this.activeOperations.delete(operationId);
    }
  }
  
  cancelOperation(operationId) {
    const controller = this.activeOperations.get(operationId);
    if (controller) {
      controller.abort();
      Logger.warn(`[RequestProcessor] 主动取消操作 (ID: ${operationId})`);
    }
  }
  
  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => {
      controller.abort();
      Logger.warn(`[RequestProcessor] 批量取消操作 (ID: ${id})`);
    });
  }
  
  _constructUrl(requestSpec) {
    const pathSegment = requestSpec.path.startsWith('/') ? 
      requestSpec.path.substring(1) : requestSpec.path;
    
    const queryParams = new URLSearchParams(requestSpec.query_params);
    const queryString = queryParams.toString();
    
    return `https://${this.targetDomain}/${pathSegment}${queryString ? '?' + queryString : ''}`;
  }
  
  _buildRequestConfig(requestSpec, signal) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal
    };
    
    if (['POST', 'PUT', 'PATCH'].includes(requestSpec.method) && requestSpec.body) {
      config.body = requestSpec.body;
    }
    
    return config;
  }
  
  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    const forbiddenHeaders = [
      'host', 'connection', 'content-length', 'origin',
      'referer', 'user-agent', 'sec-fetch-mode',
      'sec-fetch-site', 'sec-fetch-dest'
    ];
    
    forbiddenHeaders.forEach(header => delete sanitized[header]);
    return sanitized;
  }
}

// 流式响应处理器
class StreamHandler {
  constructor(communicator) {
    this.communicator = communicator;
  }
  
  async processStream(response, operationId) {
    Logger.info(`[StreamHandler] 开始处理流式响应 (ID: ${operationId})`);
    
    this._transmitHeaders(response, operationId);
    
    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    
    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          Logger.success(`[StreamHandler] 流传输完成 (ID: ${operationId})`);
          this._transmitStreamEnd(operationId);
          break;
        }
        
        const textChunk = textDecoder.decode(value, { stream: true });
        this._transmitChunk(textChunk, operationId);
      }
    } catch (error) {
      Logger.error(`[StreamHandler] 流处理中断 (ID: ${operationId}): ${error.message}`);
      this._sendStreamError(error, operationId); 
      throw error; 
    }
  }
  
  _transmitHeaders(response, operationId) {
    const headerMap = {};
    response.headers.forEach((value, key) => {
      headerMap[key] = value;
    });
    
    const headerMessage = {
      request_id: operationId,
      event_type: 'response_headers',
      status: response.status,
      headers: headerMap
    };
    
    this.communicator.transmit(headerMessage);
  }
  
  _transmitChunk(chunk, operationId) {
    const chunkMessage = {
      request_id: operationId,
      event_type: 'chunk',
      data: chunk
    };
    
    this.communicator.transmit(chunkMessage);
  }
  
  _transmitStreamEnd(operationId) {
    const endMessage = {
      request_id: operationId,
      event_type: 'stream_close'
    };
    
    this.communicator.transmit(endMessage);
  }

  _sendStreamError(error, operationId) {
    const errorMessage = {
      request_id: operationId,
      event_type: 'error', 
      status: 500, 
      message: `流处理错误 (ID: ${operationId}): ${error.message || '未知流错误'}`
    };
    this.communicator.transmit(errorMessage);
    Logger.warn(`[StreamHandler] 已向客户端发送流错误通知 (ID: ${operationId})`);
  }
}

// 主代理系统
class ProxySystem extends EventTarget {
  constructor(websocketEndpoint) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this.streamHandler = new StreamHandler(this.connectionManager);
    this.statusDot = null; // 状态灯
    
    this._setupEventHandlers();
  }
  
  async initialize() {
    Logger.system('[ProxySystem] 系统初始化中...');
    
    // [新增] 初始化右上角状态灯
    this.statusDot = document.createElement('div');
    this.statusDot.style.cssText = "position:fixed; top:15px; right:15px; width:12px; height:12px; border-radius:50%; background:gray; z-index:9999; border: 2px solid #333; transition: background 0.2s;";
    document.body.appendChild(this.statusDot);

    try {
      await this.connectionManager.establish();
      Logger.system('[ProxySystem] 系统初始化完成，就绪');
      this.dispatchEvent(new CustomEvent('ready'));
    } catch (error) {
      Logger.error('[ProxySystem] 系统初始化失败:', error.message);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
      throw error;
    }
  }
  
  _setupEventHandlers() {
    this.connectionManager.addEventListener('message', (event) => {
      // 收到消息闪烁黄色
      if (this.statusDot) {
          this.statusDot.style.background = '#f1c40f';
          setTimeout(() => this.statusDot.style.background = '#2ecc71', 100);
      }
      this._handleIncomingMessage(event.detail);
    });
    
    this.connectionManager.addEventListener('connected', () => {
        if (this.statusDot) this.statusDot.style.background = '#2ecc71'; // 绿
    });

    this.connectionManager.addEventListener('disconnected', () => {
      if (this.statusDot) this.statusDot.style.background = '#ff6b6b'; // 红
      Logger.warn('[ProxySystem] WebSocket 断开，取消所有进行中的请求');
      this.requestProcessor.cancelAllOperations();
    });
  }
  
  async _handleIncomingMessage(messageData) {
    let requestSpec; 
    try {
      requestSpec = JSON.parse(messageData);
      if (!requestSpec || !requestSpec.request_id) {
        Logger.warn('[ProxySystem] 收到无效请求: 格式错误或缺少ID');
        return;
      }
      Logger.info(`[ProxySystem] 收到新请求: ${requestSpec.method} ${requestSpec.path} (ID: ${requestSpec.request_id})`);
      
      await this._processProxyRequest(requestSpec);
    } catch (error) {
      Logger.error('[ProxySystem] 消息解析异常:', error.message);
      const operationId = requestSpec ? requestSpec.request_id : null;
      if (operationId) {
        this._sendErrorResponse(error, operationId, '消息解析错误');
      }
    }
  }
  
  async _processProxyRequest(requestSpec) {
    const operationId = requestSpec.request_id;
    
    try {
      const response = await this.requestProcessor.execute(requestSpec, operationId);
      await this.streamHandler.processStream(response, operationId);
    } catch (error) {
      if (error.name === 'AbortError') {
        Logger.warn(`[ProxySystem] 请求流程已中止 (ID: ${operationId})`);
      } else {
        Logger.error(`[ProxySystem] 请求处理失败 (ID: ${operationId}) - ${error.message}`);
        this._sendErrorResponse(error, operationId);
      }
    }
  }
  
  _sendErrorResponse(error, operationId, contextMessage = '代理系统错误') {
    if (!operationId) {
      Logger.warn('[ProxySystem] 无法发送错误响应：缺少ID');
      return;
    }
    
    const errorMessage = {
      request_id: operationId,
      event_type: 'error',
      status: error.status || 500,
      message: `${contextMessage} (ID: ${operationId}): ${error.message || '未知错误'}`
    };
    
    this.connectionManager.transmit(errorMessage);
    Logger.info(`[ProxySystem] 错误回执已发送 (ID: ${operationId})`);
  }
}

// 系统启动函数
async function initializeProxySystem() {
  const proxySystem = new ProxySystem();
  
  try {
    await proxySystem.initialize();
    Logger.system('浏览器代理系统核心已启动');
  } catch (error) {
    Logger.error('代理系统启动崩溃:', error.message);
  }
}

// 启动系统
initializeProxySystem();
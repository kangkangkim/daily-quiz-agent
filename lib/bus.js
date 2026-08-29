// 轻量事件总线：有人作答 → 广播给所有在线的榜单订阅者
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(100);

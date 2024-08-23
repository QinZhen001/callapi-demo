import { AGEventEmitter } from "../common"
import { CallMessageManagerEvents } from "../types"

/**
 * 消息管理器
 */
export abstract class CallMessageManager extends AGEventEmitter<CallMessageManagerEvents> {
  abstract sendMessage(userId: string | number, message: string): Promise<void>
}

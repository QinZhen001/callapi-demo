import {
  IAgoraRTCClient,
  enableLogUpload,
  setParameter,
  createClient,
  setLogLevel,
  createMicrophoneAndCameraTracks,
} from "agora-rtc-sdk-ng/esm"
import { v4 as uuidv4 } from "uuid"
import { CallInfo } from "./callInfo"
import { CallMessage } from "./callMessage"
import {
  ICallConfig,
  IPrepareConfig,
  ICallMessage,
  CallApiEvents,
  ILocalTracks,
  IRemoteTracks,
  CallStateType,
  CallStateReason,
  CallAction,
  RejectByInternal,
  CallType,
  LogLevel,
  CallEvent,
  CallErrorEvent,
  CallErrorCodeType,
} from "../types"
import {
  AGEventEmitter,
  logger,
  serializeHTMLElement,
  LOCAL_VIEW_ELEMENT,
  REMOTE_VIEW_ELEMENT,
} from "../common"

enableLogUpload()
setLogLevel(1)
setParameter("ENABLE_INSTANT_VIDEO", true)

export class CallApi extends AGEventEmitter<CallApiEvents> {
  callConfig: ICallConfig
  prepareConfig: IPrepareConfig = {}
  state: CallStateType = CallStateType.idle
  remoteUserId: number = 0
  localTracks: ILocalTracks = {}
  remoteTracks: IRemoteTracks = {}
  rtcClient?: IAgoraRTCClient
  callType: CallType = CallType.video
  callEvent: CallEvent = CallEvent.none
  // ------- private -------
  private _callInfo: CallInfo = new CallInfo()
  private _callMessage = new CallMessage()
  private _rtcJoined: boolean = false
  private _rtcPublished: boolean = false
  private _receiveRemoteFirstFrameDecoded = false
  private _cancelCallTimer: any = null

  get callMessageManager() {
    return this.callConfig.callMessageManager
  }

  get roomId() {
    return this.prepareConfig?.roomId || ""
  }

  get isBusy() {
    return (
      this.state == CallStateType.calling ||
      this.state == CallStateType.connected ||
      this.state == CallStateType.connecting
    )
  }

  constructor(config: ICallConfig) {
    super()
    this.callConfig = config
    this.rtcClient = config.rtcClient
      ? config.rtcClient
      : createClient({ mode: "rtc", codec: "vp9" })
    if (typeof config.logLevel == "number") {
      logger.setLogLevel(config.logLevel)
    }
    this._listenRtcEvents()
    this._listenMessagerManagerEvents()
    // privacy protection （Do not print sensitive information）
    logger.debug("init success", {
      userId: config.userId,
      logLevel: config.logLevel,
    })
  }

  // ------- public -------

  /**
   * 设置日志等级
   * @param level 等级
   */
  setLogLevel(level: LogLevel) {
    logger.setLogLevel(level)
  }

  /**
   * 获取通话Id
   */
  getCallId() {
    return this._callMessage.getCallId()
  }

  /**
   * 准备呼叫
   * @param prepareConfig 准备呼叫配置
   */
  async prepareForCall(prepareConfig: Partial<IPrepareConfig>) {
    if (this.isBusy) {
      const message = "currently busy!"
      logger.error(message)
      throw new Error(message)
    }
    this.prepareConfig = {
      ...this.prepareConfig,
      ...prepareConfig,
    }
    this._callStateChange(CallStateType.prepared, CallStateReason.none)
    const { localView, remoteView, rtcToken, ...printConfig } =
      this.prepareConfig
    logger.debug(
      "prepareForCall success",
      JSON.stringify({
        ...printConfig,
        localView: serializeHTMLElement(localView),
        remoteView: serializeHTMLElement(remoteView),
      }),
    )
  }

  /**
   * 发起呼叫 （主叫）
   * @param remoteUserId 远端用户Id
   * @param callType 呼叫类型
   */
  async call(remoteUserId: number, callType?: CallType) {
    if (this.state !== CallStateType.prepared) {
      const message = `call failed! current state:${this.state} is not prepared state ${CallStateType.prepared}`
      logger.error(message)
      throw new Error(message)
    }
    this._callInfo.start()
    this.remoteUserId = remoteUserId
    this.callType = callType ?? CallType.video
    const callStateReason =
      this.callType == CallType.video
        ? CallStateReason.localVideoCall
        : CallStateReason.localAudioCall
    this._callStateChange(CallStateType.calling, callStateReason, "", {
      remoteUserId,
      fromUserId: this.callConfig.userId,
    })
    this._callEventChange(CallEvent.onCalling)
    this._callMessage.setCallId(uuidv4())
    const callAction =
      this.callType == CallType.video
        ? CallAction.VideoCall
        : CallAction.AudioCall
    await Promise.all([
      this._rtcJoinAndPublish(),
      this._publishMessage(remoteUserId, {
        fromUserId: this.callConfig.userId,
        remoteUserId,
        fromRoomId: this.prepareConfig?.roomId,
        message_action: callAction,
      }),
    ])
    this._callInfo.add("remoteUserRecvCall")
    this._callEventChange(CallEvent.remoteUserRecvCall)
    this._autoCancelCall()
    logger.debug(`call success,remoteUserId:${remoteUserId}`)
  }

  /**
   * 取消呼叫 (主叫)
   */
  async cancelCall() {
    this._callStateChange(CallStateType.prepared, CallStateReason.localCancel)
    this._callEventChange(CallEvent.localCancel)
    await this._publishMessage(this.remoteUserId, {
      fromUserId: this.callConfig.userId,
      remoteUserId: this.remoteUserId,
      message_action: CallAction.Cancel,
      cancelCallByInternal: RejectByInternal.External,
    })
    await this.destory()
    logger.debug(`cancelCall success`)
  }

  /**
   * 拒绝通话 (被叫)
   * @param remoteUserId 远端用户Id
   * @param reason 原因
   */
  async reject(remoteUserId: number, reason?: string) {
    this._callStateChange(
      CallStateType.prepared,
      CallStateReason.localRejected,
      reason,
    )
    this._callEventChange(CallEvent.localRejected)
    await this._publishMessage(remoteUserId, {
      fromUserId: this.callConfig.userId,
      remoteUserId,
      message_action: CallAction.Reject,
      rejectReason: reason,
      rejectByInternal: RejectByInternal.External,
    })
    await this.destory()
    logger.debug(`reject success,remoteUserId:${remoteUserId},reason:${reason}`)
  }

  /**
   * 接受通话 (被叫)
   * @param remoteUserId 远端用户Id
   */
  async accept(remoteUserId: number) {
    if (this.state !== CallStateType.calling) {
      const message = `accept fail! current state:${this.state} is not calling state ${CallStateType.calling}`
      logger.error(message)
      throw new Error(message)
    }
    this._callEventChange(CallEvent.localAccepted)
    this._callInfo.add("acceptCall")
    this._callStateChange(
      CallStateType.connecting,
      CallStateReason.localAccepted,
    )
    await this._publishMessage(remoteUserId, {
      fromUserId: this.callConfig.userId,
      remoteUserId,
      message_action: CallAction.Accept,
    })
    this._checkAppendView()
    logger.debug(`accept success,remoteUserId:${remoteUserId}`)
  }

  /**
   * 挂断通话
   * @param remoteUserId 远端用户Id
   */
  async hangup(remoteUserId: number) {
    this._callStateChange(CallStateType.prepared, CallStateReason.localHangup)
    this._callEventChange(CallEvent.localHangup)
    await this._publishMessage(remoteUserId, {
      fromUserId: this.callConfig.userId,
      remoteUserId,
      message_action: CallAction.Hangup,
    })
    await this.destory()
    logger.debug(`hangup success,remoteUserId:${remoteUserId}`)
  }

  /**
   * 销毁
   */
  async destory() {
    try {
      this.remoteTracks.audioTrack?.stop()
      if (this.localTracks?.audioTrack) {
        this.localTracks?.audioTrack.close()
        logger.debug("close local audio track success")
      }
      if (this.localTracks?.videoTrack) {
        this.localTracks?.videoTrack.close()
        logger.debug("close local video track success")
      }
      if (this._rtcJoined) {
        await this.rtcClient?.leave()
        logger.debug("rtc leave success")
        this._callEventChange(CallEvent.localLeave)
      }
    } catch (e) {
      this._callError(CallErrorEvent.rtcOccurError, CallErrorCodeType.rtc, e)
    }
    this._resetData()
    logger.debug(`destory success`)
  }

  // ------- public -------

  // ------- private -------
  private _listenMessagerManagerEvents() {
    this.callMessageManager.on("messageReceive", async (message) => {
      logger.debug("message receive:", message)
      const data = this._callMessage.decode(message)
      const { message_action } = data
      switch (message_action) {
        // receive video call
        case CallAction.VideoCall:
          await this._receiveVideoCall(data)
          break
        // receive audio call
        case CallAction.AudioCall:
          // TODO: audio call
          break
        // receive cancel
        case CallAction.Cancel:
          await this._receiveCancelCall(data)
          break
        // receive accept
        case CallAction.Accept:
          await this._receiveAccept(data)
          break
        // receive reject
        case CallAction.Reject:
          await this._receiveReject(data)
          break
        // receive hangup
        case CallAction.Hangup:
          await this._receiveHangup(data)
          break
      }
    })
  }

  private async _receiveCancelCall(data: ICallMessage) {
    const { fromUserId, cancelCallByInternal } = data
    if (!this._isCallingUser(fromUserId)) {
      return
    }
    this._callStateChange(
      CallStateType.prepared,
      CallStateReason.remoteCancel,
      "",
      { cancelCallByInternal },
    )
    this._callEventChange(CallEvent.remoteCancel)
    await this.destory()
  }

  private async _receiveVideoCall(data: ICallMessage) {
    const { callId, fromUserId, fromRoomId, remoteUserId } = data
    if (!this._isCallingUser(fromUserId)) {
      this._autoReject(Number(fromUserId))
      return
    }
    this._callInfo.start()
    this._callMessage.setCallId(callId)
    this.remoteUserId = Number(fromUserId)
    this.prepareConfig.roomId = fromRoomId
    this._callStateChange(
      CallStateType.calling,
      CallStateReason.remoteVideoCall,
      "",
      // on this eventInfo
      // remoteUserId 指向本次通话的被叫方
      // fromUserId 指向本次通话的主叫方
      {
        remoteUserId: Number(remoteUserId),
        fromUserId: Number(fromUserId),
      },
    )
    this._callEventChange(CallEvent.onCalling)
    await this._rtcJoinAndPublish()
    if (this.prepareConfig?.autoAccept) {
      await this.accept(this.remoteUserId)
    }
  }

  private async _receiveAccept(data: ICallMessage) {
    this._callInfo.add("acceptCall")
    this._callEventChange(CallEvent.remoteAccepted)
    this._callStateChange(
      CallStateType.connecting,
      CallStateReason.remoteAccepted,
    )
    this._checkAppendView()
  }

  private async _receiveHangup(data: ICallMessage) {
    const { fromUserId } = data
    if (!this._isCallingUser(fromUserId)) {
      return
    }
    this._callStateChange(CallStateType.prepared, CallStateReason.remoteHangup)
    this._callEventChange(CallEvent.remoteHangup)
    await this.destory()
  }

  private async _receiveReject(data: ICallMessage) {
    const { fromUserId, rejectByInternal, rejectReason } = data
    if (!this._isCallingUser(fromUserId)) {
      return
    }
    const stateReason =
      rejectByInternal == RejectByInternal.Internal
        ? CallStateReason.remoteCallBusy
        : CallStateReason.remoteRejected
    if (stateReason == CallStateReason.remoteCallBusy) {
      this._callEventChange(CallEvent.remoteCallBusy)
    }
    // this._receiveReject = true
    await this.destory()
    this._callStateChange(CallStateType.prepared, stateReason, "", {
      rejectReason,
    })
    this._callEventChange(CallEvent.remoteRejected)
  }

  private _isCallingUser = (userId: string | number) => {
    if (!this.remoteUserId) {
      return true
    }
    return this.remoteUserId == Number(userId)
  }

  /**
   * 检查是否可以将视频流添加到 localView/remoteView 视图
   * 当前状态不为connecting 不可 append
   * prepareConfig.firstFrameWaittingDisabled true 不等待首帧可append
   * prepareConfig.firstFrameWaittingDisabled false 需要等待首帧才要append
   */
  private _checkAppendView() {
    if (this.state !== CallStateType.connecting) {
      return
    }
    if (
      this.prepareConfig?.firstFrameWaittingDisabled ||
      this._receiveRemoteFirstFrameDecoded
    ) {
      this._callStateChange(
        CallStateType.connected,
        CallStateReason.recvRemoteFirstFrame,
      )
      const { localView, remoteView } = this.prepareConfig
      // set local video view to localView
      if (localView) {
        localView.appendChild(LOCAL_VIEW_ELEMENT)
        this._playLocalVideo()
      } else {
        const msg = "localView is undefined"
        logger.error(msg)
        throw new Error(msg)
      }
      // set remote video view to remoteView
      if (remoteView) {
        remoteView.appendChild(REMOTE_VIEW_ELEMENT)
        this._palyRemoteVideo()
      } else {
        const msg = "remoteView is undefined"
        logger.error(msg)
        throw new Error(msg)
      }
      // play remote audio
      this._playRemoteAudio()
    }
  }

  private async _rtcJoinAndPublish() {
    try {
      // parallel create track and rtc join
      await Promise.all([this._createLocalTracks(), this._rtcJoin()])
      this._playLocalVideo()
      // then publish track
      await this._rtcPublish()
    } catch (err) {
      this._callError(CallErrorEvent.rtcOccurError, CallErrorCodeType.rtc, err)
    }
  }

  private _playLocalVideo() {
    const videoTrack = this.localTracks.videoTrack
    if (!videoTrack) {
      const msg = "local video track is undefined"
      return logger.debug(msg)
    }
    if (videoTrack.isPlaying) {
      return logger.debug("local video track is playing")
    }
    LOCAL_VIEW_ELEMENT.innerHTML = ""
    videoTrack.play(LOCAL_VIEW_ELEMENT)
    logger.debug("local video track play success")
  }

  private _palyRemoteVideo() {
    const videoTrack = this.remoteTracks.videoTrack
    if (!videoTrack) {
      const msg = "remote video track is undefined"
      return logger.debug(msg)
    }
    if (videoTrack.isPlaying) {
      return logger.debug("remote video track is playing")
    }
    REMOTE_VIEW_ELEMENT.innerHTML = ""
    videoTrack.play(REMOTE_VIEW_ELEMENT)
    logger.debug("remote video track play success")
  }

  private _playRemoteAudio() {
    const audioTrack = this.remoteTracks.audioTrack
    if (!audioTrack) {
      const msg = "remote audio track is undefined"
      return logger.debug(msg)
    }
    if (audioTrack.isPlaying) {
      return logger.debug("remote audio track is playing")
    }
    audioTrack.play()
    logger.debug("remote audio track play success")
  }

  private _listenRtcEvents() {
    this.rtcClient?.on("user-joined", (user) => {
      if (user.uid != this.remoteUserId) {
        return
      }
      logger.debug(`rtc remote user join,uid:${user.uid}`)
      this._callInfo.add("remoteUserJoinChannel")
      this._callEventChange(CallEvent.remoteJoin)
    })
    this.rtcClient?.on("user-left", async (user) => {
      if (user.uid != this.remoteUserId) {
        return
      }
      logger.debug(`rtc remote user leave,uid:${user.uid}`)
      this._callEventChange(CallEvent.remoteLeave)
      if (this.isBusy) {
        await this.destory()
        this._callStateChange(
          CallStateType.prepared,
          CallStateReason.remoteHangup,
        )
      }
    })
    this.rtcClient?.on("user-published", async (user, mediaType) => {
      if (user.uid != this.remoteUserId) {
        return
      }
      await this.rtcClient?.subscribe(user, mediaType)
      logger.debug(
        `subscribe user success,uid:${user.uid},mediaType:${mediaType}`,
      )
      if (mediaType === "video") {
        const remoteVideoTrack = user.videoTrack
        this.remoteTracks.videoTrack = remoteVideoTrack
        remoteVideoTrack?.on(
          "first-frame-decoded",
          this._handleRemoteFirstFrameDecoded.bind(this),
        )
        this._palyRemoteVideo()
      } else if (mediaType == "audio") {
        const remoteAudioTrack = user.audioTrack
        this.remoteTracks.audioTrack = remoteAudioTrack
        if (
          this.state == CallStateType.connected &&
          this.prepareConfig.firstFrameWaittingDisabled
        ) {
          // 如果首帧不关联,有可能会导致有加频道前变成connected,这个时候没有声音
          // 这种情况下这里需要主动播放声音
          logger.debug(
            "play remote audio track when firstFrameWaittingDisabled",
          )
          this._playRemoteAudio()
        }
      }
    })
    this.rtcClient?.on("user-unpublished", async (user, mediaType) => {
      if (user.uid != this.remoteUserId) {
        return
      }
      await this.rtcClient?.unsubscribe(user, mediaType)
      logger.debug(
        `unsubscribe user success,uid:${user.uid},mediaType:${mediaType}`,
      )
      if (mediaType === "video") {
        this.remoteTracks.videoTrack = undefined
      } else if (mediaType == "audio") {
        this.remoteTracks.audioTrack = undefined
      }
    })
    // this.rtcClient?.on("token-privilege-will-expire", async () => {
    //   // TODO:
    //   // rtm renew token
    // })
  }

  private async _autoReject(remoteUserId: number) {
    await this._publishMessage(remoteUserId, {
      fromUserId: this.callConfig.userId,
      remoteUserId,
      message_action: CallAction.Reject,
      rejectReason: "busy",
      rejectByInternal: RejectByInternal.Internal,
    })
    logger.debug(`busy state, auto reject remoteUserId:${remoteUserId} success`)
  }

  private async _autoCancelCall() {
    if (!this.remoteUserId) {
      return
    }
    const time = this.prepareConfig?.callTimeoutMillisecond
    if (time) {
      if (this._cancelCallTimer) {
        clearTimeout(this._cancelCallTimer)
        this._cancelCallTimer = null
      }
      this._cancelCallTimer = setTimeout(async () => {
        if (
          this.state == CallStateType.calling ||
          this.state == CallStateType.connecting
        ) {
          await this._publishMessage(this.remoteUserId, {
            fromUserId: this.callConfig.userId,
            remoteUserId: this.remoteUserId,
            message_action: CallAction.Cancel,
            cancelCallByInternal: RejectByInternal.Internal,
          })
          await this.destory()
          this._callStateChange(
            CallStateType.prepared,
            CallStateReason.callingTimeout,
          )
          logger.debug(`call timeout auto cancel call success`)
        }
      }, time)
    }
  }

  private async _rtcJoin() {
    if (this._rtcJoined) {
      return
    }
    const { appId, userId } = this.callConfig
    const { rtcToken, roomId } = this.prepareConfig
    if (!roomId) {
      throw new Error("roomId is undefined")
    }
    if (!rtcToken) {
      throw new Error("rtcToken is undefined")
    }
    await this.rtcClient?.join(appId, roomId, rtcToken, userId)
    logger.debug(`rtc join success,roomId:${roomId},userId:${userId}`)
    this._rtcJoined = true
    this._callEventChange(CallEvent.localJoin)
    this._callInfo.add("localUserJoinChannel")
  }

  private async _createLocalTracks() {
    const { audioConfig, videoConfig } = this.prepareConfig!
    const tracks = await createMicrophoneAndCameraTracks(
      audioConfig,
      videoConfig,
    )
    this.localTracks.audioTrack = tracks[0]
    this.localTracks.videoTrack = tracks[1]
  }

  private async _rtcPublish() {
    if (this.localTracks.videoTrack && this.localTracks.audioTrack) {
      const connectionState = this.rtcClient?.connectionState
      if (connectionState !== "CONNECTED") {
        const msg = "rtcClient connectionState is not CONNECTED"
        logger.warn(msg)
        return
      }
      if (!this._rtcPublished) {
        this._rtcPublished = true
        await this.rtcClient?.publish([
          this.localTracks.videoTrack,
          this.localTracks.audioTrack,
        ])
        logger.debug("rtc publish success")
      }
    } else {
      const msg = "videoTrack or audioTrack is undefined"
      logger.warn(msg)
    }
  }

  private async _publishMessage(
    uid: string | number,
    message: Partial<ICallMessage>,
  ) {
    try {
      const encodeMessage = this._callMessage.encode(message)
      await this.callMessageManager.sendMessage(uid.toString(), encodeMessage)
      logger.debug(`message send uid:${uid} `, encodeMessage)
    } catch (e) {
      this._callEventChange(CallEvent.messageFailed)
      this._callError(
        CallErrorEvent.sendMessageFail,
        CallErrorCodeType.message,
        e,
      )
    }
  }

  private _callError(
    errorEvent: CallErrorEvent,
    errorType: CallErrorCodeType,
    err: any,
  ) {
    logger.error(
      `onCallError! errorEvent:${errorEvent},errorType:${errorType},errorCode:${err.code},message:${err.message}`,
    )
    this.emit("callError", errorEvent, errorType, err.code, err.message)
  }

  private _callStateChange(
    state: CallStateType,
    stateReason: CallStateReason,
    eventReason?: string,
    eventInfo?: Record<string, any>,
  ) {
    if (this.state == state) {
      return
    }
    this.state = state
    logger.debug(
      "callStateChanged",
      state,
      stateReason,
      eventReason,
      JSON.stringify(eventInfo),
    )
    this.emit("callStateChanged", state, stateReason, eventReason, eventInfo)
  }

  private _callEventChange(event: CallEvent) {
    if (this.callEvent == event) {
      return
    }
    this.callEvent = event
    logger.debug("callEventChanged", event)
    this.emit("callEventChanged", event)
  }

  private _resetData() {
    this._callMessage.setCallId("")
    this.remoteUserId = 0
    this.localTracks = {}
    this.remoteTracks = {}
    this._rtcJoined = false
    this._rtcPublished = false
    // this._acceptOperate = false
    this._receiveRemoteFirstFrameDecoded = false
    this.callEvent = CallEvent.none
    this._resetView()
    if (this._cancelCallTimer) {
      clearTimeout(this._cancelCallTimer)
      this._cancelCallTimer = null
    }
    this._callInfo.end()
  }

  private _resetView() {
    const { localView, remoteView } = this.prepareConfig
    if (localView) {
      localView.innerHTML = ""
    }
    if (remoteView) {
      remoteView.innerHTML = ""
    }
  }

  private _handleRemoteFirstFrameDecoded() {
    this._callEventChange(CallEvent.recvRemoteFirstFrame)
    this._receiveRemoteFirstFrameDecoded = true
    this._callInfo.add("recvFirstFrame")
    const info = this._callInfo.getInfo()
    this.emit("callInfoChanged", info)
    logger.debug("callInfoChanged: ", info)
    this._checkAppendView()
  }
  // ------- private -------
}

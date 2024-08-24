import { useEffect, useState, useMemo } from "react"
import {
  getRandomUid, apiGenerateToken,
  genUUID, DEFAULT_RTM_CONFIG, APPID, APPCERTIFICATE,
  CALL_TIMEOUT_MILLISECOND, DEFAULT_VIDEO_ENCODER_CONFIG,
} from "./utils"
import { createClient, IAgoraRTCClient } from "agora-rtc-sdk-ng/esm"
import AgoraRTM from "agora-rtm"
import {
  CallRtmMessageManager, LogLevel, CallApi, CallStateType,
  CallErrorCodeType, CallStateReason, CallErrorEvent
} from "./callApi"
import { message } from 'antd';

const { RTM } = AgoraRTM
const localUserId = getRandomUid()
let rtcClient: IAgoraRTCClient
let rtmClient
let callApi: CallApi


export enum Role {
  // 主叫
  Caller = "caller",
  // 被叫
  Called = "called",
}

function App() {
  const [remoteUserId, setRemoteUserId] = useState(0)
  const [firstFrameWaittingDisabled, setFirstFrameWaittingDisabled] = useState(false)
  const [state, setState] = useState(CallStateType.idle)
  const [eventInfo, setEventInfo] = useState<any>({})

  useEffect(() => { init() }, [])

  // 角色
  const role = useMemo(() => {
    return eventInfo?.remoteUserId == localUserId ? Role.Called : Role.Caller
  }, [eventInfo, localUserId])

  const init = async () => {
    const token = await apiGenerateToken(localUserId)
    // rtc init
    rtcClient = createClient({ mode: "live", codec: "vp9", role: "host" })
    // rtm init
    const rtmConfig = DEFAULT_RTM_CONFIG
    rtmConfig.token = token
    rtmClient = new RTM(APPID, localUserId + "", rtmConfig)
    // rtm login 
    try {
      await rtmClient.login()
      message.success("rtm login success")
    } catch (e: any) {
      // catch rtm login error
      message.error(e.message)
    }
    // init callMessageManager
    const callMessageManager = new CallRtmMessageManager({
      appId: APPID,
      userId: localUserId,
      rtmToken: token,
      rtmClient: rtmClient,
    })
    // init callApi
    callApi = new CallApi({
      appId: APPID,
      appCertificate: APPCERTIFICATE,
      userId: localUserId,
      callMessageManager,
      rtcClient: rtcClient,
      logLevel: LogLevel.DEBUG,
    })
    // listen callApi event
    addCallApiEventListener()
    // first prepareForCall
    callApi.prepareForCall({
      roomId: genUUID(),
      rtcToken: token,
      // must in dom
      localView: document.getElementById("local-view")!,
      // must in dom
      remoteView: document.getElementById("remote-view")!,
      autoAccept: false,
      callTimeoutMillisecond: CALL_TIMEOUT_MILLISECOND,
      firstFrameWaittingDisabled,
      videoConfig: {
        encoderConfig: DEFAULT_VIDEO_ENCODER_CONFIG,
      },
    })
  }

  const addCallApiEventListener = () => {
    callApi.on("callInfoChanged", (info) => {
      // show call info if needed
    })
    callApi.on(
      "callStateChanged",
      (state, stateReason, eventReason, eventInfo) => {
        setState(state)
        switch (state) {
          case CallStateType.prepared:
            setEventInfo(eventInfo)
            if (stateReason == CallStateReason.remoteHangup) {
              message.info("对方结束连线")
            } else if (stateReason == CallStateReason.remoteRejected) {
              message.info("对方已拒绝")
            } else if (stateReason == CallStateReason.remoteCallBusy) {
              message.info("对方已拒绝")
            } else if (stateReason == CallStateReason.callingTimeout) {
              // call timeout
            }
            break
          case CallStateType.calling:
            setEventInfo(eventInfo)
        }
      },
    )
    callApi.on("callEventChanged", (event) => {
      // handle call event if needed
    })
    callApi.on("callError", (errorEvent, errorType, errorCode, errMessage) => {
      switch (errorType) {
        case CallErrorCodeType.normal:
          // 常规错误
          break
        case CallErrorCodeType.rtc:
          // rtc错误
          // https://doc.shengwang.cn/doc/rtc/javascript/error-code
          if (errorCode == "PERMISSION_DENIED") {
            message.error("请检查摄像头和麦克风权限")
          }
          break
        case CallErrorCodeType.message:
          // 消息错误
          // https://doc.shengwang.cn/doc/rtm2/javascript/error-codes#%E9%94%99%E8%AF%AF%E7%A0%81%E5%AF%B9%E7%85%A7%E8%A1%A8
          if (errorEvent == CallErrorEvent.sendMessageFail) {
            message.error("消息发送失败")
          }
          break
      }
    })
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRemoteUserId(Number(e.target.value))
  }

  const onClickFirstFrameWaittingDisabled = () => {
    setFirstFrameWaittingDisabled(!firstFrameWaittingDisabled)
    callApi.prepareForCall({
      firstFrameWaittingDisabled: !firstFrameWaittingDisabled,
    })
  }

  const call = async () => {
    await callApi.call(remoteUserId)
  }

  const cancelCall = async () => {
    await callApi.cancelCall()
  }

  const accept = async () => {
    await callApi.accept(remoteUserId)
  }

  const reject = async () => {
    await callApi.reject(remoteUserId)
  }

  const hangup = async () => {
    await callApi.hangup(remoteUserId)
  }

  return <div>
    <div className="item">Local UserId: {localUserId}</div>
    <div className="item">
      Remote UserId: <input type="text" value={remoteUserId} onChange={onChange} />
    </div>
    <div className="item">
      <button onClick={onClickFirstFrameWaittingDisabled}>音频首帧与接通相关 {String(!firstFrameWaittingDisabled)}</button>
    </div>
    <div className="item">
      <button onClick={call}>call 呼叫</button>
      <button onClick={cancelCall}>cancelCall 取消呼叫</button>
      <button onClick={accept}>accept 接受</button>
      <button onClick={reject}>reject 拒绝</button>
      <button onClick={hangup}>hangup 挂断</button>
    </div>
    <div className="stream-section">
      <div className="localUser">
        <span>localUser:{ }</span>
        <div id="local-view"></div>
      </div>
      <div className="remoteUser">
        <span>remoteUser:{ }</span>
        <div id="remote-view"></div>
      </div>
    </div>
  </div>
}

export default App

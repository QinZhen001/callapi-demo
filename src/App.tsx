import { useEffect, useState } from "react"
import { getRandomUid, apiGenerateToken, DEFAULT_RTM_CONFIG, APPID } from "./utils"
import { createClient, IAgoraRTCClient } from "agora-rtc-sdk-ng/esm"
import AgoraRTM from "agora-rtm"


const localUserId = getRandomUid()
let rtcClient: IAgoraRTCClient
let rtmClient
const { RTM } = AgoraRTM

function App() {
  const [remoteUserId, setRemoteUserId] = useState(0)

  useEffect(() => { init() }, [])


  const init = async () => {
    const token = await apiGenerateToken(localUserId)
    // rtc init
    rtcClient = createClient({ mode: "live", codec: "vp9", role: "host" })
    // rtm init
    const rtmConfig = DEFAULT_RTM_CONFIG
    rtmConfig.token = token
    rtmClient = new RTM(APPID, localUserId + "", rtmConfig)
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRemoteUserId(Number(e.target.value))
  }

  return <div>
    <div className="item">Local UserId: {localUserId}</div>
    <div className="item">
      Remote UserId: <input type="text" value={remoteUserId} onChange={onChange} />
    </div>
    <div className="item">
      <button>音频首帧与接通相关</button>
    </div>
    <div className="item">
      <button></button>
    </div>
  </div>
}

export default App

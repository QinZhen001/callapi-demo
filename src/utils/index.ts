import { RTMConfig } from "agora-rtm"

export const APPID = import.meta.env.VITE_AGORA_APP_ID
export const APPCERTIFICATE = import.meta.env.VITE_AGORA_APP_CERTIFICATE
export const DEFAULT_RTM_CONFIG: RTMConfig = {
  logLevel: "error",
  logUpload: true,
  presenceTimeout: 30,
}


export const getRandomUid = () => {
  return Math.floor(1000 + Math.random() * 9000);
}


export const apiGenerateToken = async (
  uid: string | number,
  channelName: string = "",
) => {
  const url = "https://toolbox.bj2.agoralab.co/v2/token/generate"
  const data = {
    appId: APPID,
    appCertificate: APPCERTIFICATE,
    channelName,
    expire: 7200,
    src: "ios",
    types: [1, 2],
    uid: uid + "",
  }
  let resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  }) as unknown as any
  resp = (await resp.json()) || {}
  return resp?.data?.token || null
}

// Pet settings translations copied from OpenAlice.
import { messages as en } from './en'
export const messages = {
  activityPreferences: en.activityPreferences,
  pet: {
    title: '桌寵', sound: '點擊音效',
    description: '自訂桌寵的點擊音效。拖動時保持安靜，設定只儲存在這台裝置上。',
    enabled: '點擊時播放音效', volume: '音量', file: '音效檔案',
    noFile: '尚未選擇音效，點擊時不會播放聲音。',
    fileHelp: 'WAV、MP3 或 OGG，最大 2 MB、最長 10 秒。檔案會複製到本機，不會上傳。',
    choose: '選擇音訊…', preview: '試聽', reset: '恢復預設',
    resetHelp: '恢復預設會回到 OpenAlice 內建的柔和雙響，並將音量重設為 50%。關閉點擊音效後仍可試聽。',
    loading: '正在載入桌寵設定…', saving: '正在儲存…',
    desktopOnly: '啟用桌寵後，可在桌面應用程式中設定音效。',
    error: { unavailable: '桌寵設定暫時無法使用，請重新開啟此頁面。', invalidFile: '請選擇可播放的 WAV、MP3 或 OGG 檔案，最大 2 MB、最長 10 秒。', failed: '無法儲存桌寵設定，請重試。', playback: '無法播放此音訊，請選擇其他檔案。' },
  },
}

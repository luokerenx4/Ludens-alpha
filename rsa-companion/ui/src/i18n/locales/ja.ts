// Pet settings translations copied from OpenAlice.
import { messages as en } from './en'
export const messages = {
  activityPreferences: en.activityPreferences,
  pet: {
    title: 'ペット', sound: 'クリック音',
    description: 'ペットのクリック音を設定します。ドラッグ時は鳴りません。設定はこの端末に保存されます。',
    enabled: 'クリック時に音を鳴らす', volume: '音量', file: '音声ファイル',
    noFile: '音声未選択 — クリック音は鳴りません。',
    fileHelp: 'WAV、MP3、OGG · 最大 2 MB、10 秒。端末にコピーを保存し、アップロードしません。',
    choose: '音声を選択…', preview: '試聴', reset: '初期設定に戻す',
    resetHelp: '初期化すると OpenAlice 内蔵の柔らかな 2 音のクリック音に戻り、音量を 50% に戻します。クリック音がオフでも試聴できます。',
    loading: 'ペット設定を読み込み中…', saving: '保存中…',
    desktopOnly: 'ペットを有効にすると、デスクトップアプリで音声を設定できます。',
    error: { unavailable: 'ペット設定を利用できません。ページを開き直してください。', invalidFile: '再生可能な WAV、MP3、OGG を選択してください。最大 2 MB、10 秒です。', failed: '設定を保存できませんでした。再試行してください。', playback: '再生できません。別のファイルを選択してください。' },
  },
}

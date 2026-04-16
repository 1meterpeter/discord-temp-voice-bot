/**
 * Zentrale Standardwerte für den TempVoice-Bot.
 */
module.exports = {
  /**
   * Standard-Userlimit für neue Channels.
   * 0 = unbegrenzt
   */
  defaultUserLimit: 0,

  /**
   * Prefix vor jedem Voicechannel-Namen.
   */
  voicePrefix: "🔊",

  /**
   * Standard-Endung für automatisch generierte Namen.
   * Beispiel:
   * "Peter's Talk"
   */
  defaultChannelName: "Talk",

  /**
   * Aktuell nicht aktiv im neuen Panel verwendet,
   * kann aber für klassische Embed-/Panel-Varianten später nützlich sein.
   */
  panelMessageTitle: "VoiceMaster Interface",

  /**
   * Noch nicht vollständig in der Permission-Prüfung aktiv verdrahtet,
   * bleibt aber als Option für spätere Admin-Panel-Steuerung erhalten.
   */
  allowAdminsToManage: true
};
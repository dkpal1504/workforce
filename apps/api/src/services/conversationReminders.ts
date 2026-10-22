/**
 * The ONE switch that decides whether the application may mail anybody on its own.
 *
 * The user's rider, in their words: "reminders will be switched off from the configuration. Once it is
 * enabled then only system should send the reminders." So the default is OFF, and OFF means no reminder
 * at 8h, no escalation at 24h, no chase — not "off by accident because a variable is missing".
 *
 * WHY A MODULE AND NOT A CHECK AT EACH CALL SITE: a config flag that is read in four places is a flag
 * that will be read differently in three of them, and the one that forgets it sends mail nobody asked
 * for. Everything that could send unattended mail asks this function first.
 *
 * Person-posted mail is NOT gated: when a person presses Send, the thread is mailed as it always was.
 * That is an action somebody took, not the application deciding to speak.
 */
export function remindersEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CONVERSATION_REMINDERS_ENABLED ?? "false").toLowerCase() === "true";
}

/** Printed once at startup so an operator can see WHY the ladder is quiet. */
export function remindersState(env: NodeJS.ProcessEnv = process.env): string {
  return remindersEnabled(env)
    ? "reminders: ON (the application will remind and escalate on its own)"
    : "reminders: OFF (CONVERSATION_REMINDERS_ENABLED is not set to true — no automatic mail)";
}

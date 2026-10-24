// Lets any part of the page (a Needs-you card, a starter chip) put a draft in the chat composer for the owner to finish.

export const COMPOSE_EVENT = "agent:compose"

export function compose(text: string) {
  window.dispatchEvent(new CustomEvent<string>(COMPOSE_EVENT, { detail: text }))
}

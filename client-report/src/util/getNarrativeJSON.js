const getNarrativeJSON = (narrative, model) => {
  switch (model) {
    case "openai":
      return JSON.parse(`{${narrative?.modelResponse?.content[0]?.text}`)
    case "gemini":
      return JSON.parse(narrative?.modelResponse)
    case "claude":
      return JSON.parse(`{${narrative?.modelResponse?.content[0]?.text}`)
    default:
      return {}
  }
}

export default getNarrativeJSON;
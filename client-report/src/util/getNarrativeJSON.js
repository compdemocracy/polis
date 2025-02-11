const getNarrativeJSON = (narrative) => {
  return JSON.parse(narrative?.modelResponse || `{}`)
}

export default getNarrativeJSON;

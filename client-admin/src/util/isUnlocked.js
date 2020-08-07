function canDoAnything() {
  return process.env.REACT_APP_DISABLE_PLANS
}

export default user => {
  return (user && user.planCode >= 1) || canDoAnything()
}

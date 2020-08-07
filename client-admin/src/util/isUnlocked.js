function canDoAnything() {
  return process.env.RAZZLE_DISABLE_PLANS
}

export default user => {
  return (user && user.planCode >= 1) || canDoAnything()
}

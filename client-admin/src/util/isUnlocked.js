function canDoAnything() {
  return !window.usePlans;
}

export default (user) => {
  return (user && user.planCode >= 1) || canDoAnything();
};

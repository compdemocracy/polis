
function hasPlanCode1(user) {
  return user && user.planCode >= 1;
}

export const getPlanName = (user) => {
  let name;

  if (user.planCode === 0) {
    name = "Free"
  } else if (user.planCode > 0) {
    name = "Professional"
  }

  return name;
}

export const planCodes = {
  free: 0,
  pro: 300,
};

export const lockedIcon = " 🔒";

export default {

  canEditReports: hasPlanCode1,
  canViewStats: hasPlanCode1,
  canExportData: hasPlanCode1,

  canCustomizeColors: hasPlanCode1,
  canToggleCommentForm: hasPlanCode1,
  canTogglePolisBranding: hasPlanCode1,
  canToggleVisVisibility: hasPlanCode1,
  canToggleStrictMod: hasPlanCode1,

  plansRoute: "/pricing",
};




function hasPlanCode1(user) {
  return user && user.planCode >= 1;
}



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


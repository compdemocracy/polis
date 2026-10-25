export const importErrorMessage = (error) => {
  try {
    const body = JSON.parse(error.responseText)
    if (body.error === 'polis_err_import_target_not_empty') return body.message
  } catch { /* Fall back to the existing error for other failures. */ }
  return error.responseText || error.message
}

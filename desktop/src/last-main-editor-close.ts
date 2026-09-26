type CloseableEditor = { close(): Promise<void> };

/**
 * Keep the main window and its sessions alive until the editor has answered
 * its unsaved-changes confirmation and actually closed.
 */
export async function requestEditorCloseBeforeLastMainWindow(
  mainWindowCount: number,
  getEditor: () => Promise<CloseableEditor | null>,
  requestClose: (editor: CloseableEditor) => Promise<boolean>,
): Promise<boolean> {
  if (mainWindowCount > 1) return true;
  try {
    const editor = await getEditor();
    if (!editor) return true;
    return await requestClose(editor);
  } catch (error) {
    console.error('Unable to confirm the editor closed:', error);
    return false;
  }
}

// Only cosmetic, reversible preferences can suppress a future confirmation.
export const canRememberConfirmation = (id) => ['hideProgram', 'hidePrograms'].includes(id);
export const confirmationLabel = (message) => /uninstall/i.test(message) ? 'Uninstall' : /delete|remove|erase/i.test(message) ? 'Remove selected items' : /restart/i.test(message) ? 'Restart' : /disable|turn off/i.test(message) ? 'Turn off' : 'Confirm change';

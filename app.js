// app.js – minimal test
alert('Hello from app.js');

// Now try to import a known file and call a function
import { showModal } from './ui.js';

window.addEventListener('load', () => {
  alert('Window loaded');
  try {
    showModal('modal-new-existing');
    alert('Modal should be visible now');
  } catch (e) {
    alert('Error showing modal: ' + e.message);
  }
});
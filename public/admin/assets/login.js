(() => {
  const messages = {
    bad: 'That password is not right. Try again.',
    throttled: 'Too many attempts. Wait 15 minutes and try again.',
    disabled: 'Sign-in is off because ADMIN_PASSWORD is not set in .env.',
  };
  const e = new URLSearchParams(location.search).get('e');
  const el = document.getElementById('err');
  if (e && messages[e]) {
    el.textContent = messages[e];
    el.hidden = false;
  }
})();

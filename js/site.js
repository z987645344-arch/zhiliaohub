(() => {
  document.documentElement.classList.add("js");

  const navToggle = document.querySelector(".nav-toggle");
  const siteNav = document.querySelector(".site-nav");

  const closeNavigation = () => {
    if (!navToggle || !siteNav) return;
    navToggle.setAttribute("aria-expanded", "false");
    siteNav.classList.remove("is-open");
  };

  if (navToggle && siteNav) {
    navToggle.addEventListener("click", () => {
      const willOpen = navToggle.getAttribute("aria-expanded") !== "true";
      navToggle.setAttribute("aria-expanded", String(willOpen));
      siteNav.classList.toggle("is-open", willOpen);
    });

    siteNav.addEventListener("click", (event) => {
      if (event.target.closest("a")) closeNavigation();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeNavigation();
    });

    document.addEventListener("click", (event) => {
      if (!siteNav.classList.contains("is-open")) return;
      if (!siteNav.contains(event.target) && !navToggle.contains(event.target)) {
        closeNavigation();
      }
    });

    window.matchMedia("(min-width: 761px)").addEventListener("change", (event) => {
      if (event.matches) closeNavigation();
    });
  }

  document.querySelectorAll("[data-current-year]").forEach((element) => {
    element.textContent = String(new Date().getFullYear());
  });

  const feedbackForm = document.querySelector("[data-feedback-form]");
  const feedbackStatus = document.querySelector("[data-feedback-status]");

  if (feedbackForm && feedbackStatus) {
    feedbackForm.addEventListener("submit", (event) => {
      event.preventDefault();
      feedbackStatus.textContent = "该功能暂未开放：本页不会发送或保存你填写的内容。";
      feedbackStatus.classList.add("is-visible");
      feedbackStatus.focus();
    });
  }

  const commentForm = document.querySelector("[data-comment-form]");
  const commentScope = commentForm?.closest("[data-action-scope]");
  const commentStatus = commentScope?.querySelector("[data-action-status]");

  if (commentForm && commentStatus) {
    commentForm.addEventListener("submit", (event) => {
      event.preventDefault();
      commentStatus.textContent = "该功能暂未开放：评论不会发送、保存或对外展示。";
      commentStatus.classList.add("is-visible");
      commentStatus.focus();
    });
  }

  document.querySelectorAll("[data-unavailable-action]").forEach((control) => {
    control.addEventListener("click", (event) => {
      event.preventDefault();
      const scope = control.closest("[data-action-scope]");
      const status = scope?.querySelector("[data-action-status]");
      if (!status) return;
      status.textContent = control.dataset.unavailableMessage || "该功能暂未开放。";
      status.classList.add("is-visible");
      status.focus();
    });
  });
})();

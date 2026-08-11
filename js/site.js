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

  function showFeedbackStatus(status, message, isError = false) {
    status.textContent = message;
    status.classList.add("is-visible");
    status.classList.toggle("is-error", isError);
    status.focus();
  }

  document.querySelectorAll("[data-feedback-form]").forEach((feedbackForm) => {
    const feedbackStatus = feedbackForm.querySelector("[data-feedback-status]");
    if (!feedbackStatus) return;
    feedbackForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!feedbackForm.reportValidity()) return;
      const submitButton = feedbackForm.querySelector('button[type="submit"]');
      const values = new FormData(feedbackForm);
      const payload = new URLSearchParams();
      payload.set("author_name", String(values.get("author_name") || ""));
      payload.set("author_email", String(values.get("email") || ""));
      payload.set("body", String(values.get("body") || ""));
      payload.set("website", String(values.get("website") || ""));
      const parentId = String(values.get("parent_id") || "");
      if (parentId) payload.set("parent_id", parentId);

      if (submitButton) submitButton.disabled = true;
      showFeedbackStatus(feedbackStatus, "正在提交…");
      try {
        const response = await fetch(feedbackForm.action, {
          method: "POST",
          headers: { Accept: "application/json" },
          body: payload,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = result.error
            || (response.status === 429
              ? "提交过于频繁，请稍后再试。"
              : `留言未提交（HTTP ${response.status}），请检查内容后重试。`);
          showFeedbackStatus(feedbackStatus, message, true);
          return;
        }
        feedbackForm.reset();
        showFeedbackStatus(feedbackStatus, "留言已提交，正在等待审核。");
      } catch (_error) {
        showFeedbackStatus(feedbackStatus, "无法连接留言服务，请检查网络后重试。", true);
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  });

  document.querySelectorAll("[data-reply-toggle]").forEach((control) => {
    const formId = control.getAttribute("aria-controls");
    const replyForm = formId ? document.getElementById(formId) : null;
    if (!replyForm) return;
    control.addEventListener("click", () => {
      const willOpen = replyForm.hidden;
      replyForm.hidden = !willOpen;
      control.setAttribute("aria-expanded", String(willOpen));
      control.textContent = willOpen ? "收起回复" : "回复";
      if (willOpen) replyForm.querySelector('input[name="author_name"]')?.focus();
    });
  });

  document.querySelectorAll("[data-showcase-thumbs]").forEach((strip) => {
    const stage = strip.closest(".showcase-left")?.querySelector("[data-showcase-stage]");
    if (!stage) return;

    strip.querySelectorAll(".showcase-thumb").forEach((thumbnail) => {
      thumbnail.addEventListener("click", () => {
        const source = thumbnail.dataset.src;
        const type = thumbnail.dataset.type;
        if (!source || !["image", "video"].includes(type)) return;

        strip.querySelectorAll(".showcase-thumb").forEach((item) => {
          const active = item === thumbnail;
          item.classList.toggle("is-active", active);
          item.setAttribute("aria-pressed", String(active));
        });

        const media = document.createElement(type === "video" ? "video" : "img");
        media.className = "showcase-main";
        media.src = source;
        if (type === "video") {
          media.controls = true;
          media.preload = "metadata";
          media.playsInline = true;
          media.setAttribute("aria-label", thumbnail.getAttribute("aria-label") || "作品辅视频");
        } else {
          media.alt = thumbnail.getAttribute("aria-label") || "作品辅图";
          media.decoding = "async";
        }
        stage.replaceChildren(media);
      });
    });
  });

  document.querySelectorAll("[data-work-slider]").forEach((slider) => {
    const track = slider.querySelector("[data-work-track]");
    const previous = slider.querySelector("[data-scroll-prev]");
    const next = slider.querySelector("[data-scroll-next]");
    if (!track || !previous || !next) return;

    const edgeTolerance = 4;
    const maximumScroll = () => Math.max(0, track.scrollWidth - track.clientWidth);
    const setControlState = (control, disabled) => {
      control.disabled = disabled;
      control.setAttribute("aria-disabled", String(disabled));
    };
    const updateControls = () => {
      const maximum = maximumScroll();
      setControlState(previous, maximum <= edgeTolerance || track.scrollLeft <= edgeTolerance);
      setControlState(next, maximum <= edgeTolerance || track.scrollLeft >= maximum - edgeTolerance);
    };
    const scrollDistance = () => {
      const cards = track.querySelectorAll(".portfolio-card");
      if (cards.length > 1) return Math.max(1, cards[1].offsetLeft - cards[0].offsetLeft);
      return Math.max(1, track.clientWidth);
    };
    const scrollByCard = (direction) => {
      track.scrollBy({
        left: scrollDistance() * direction,
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      });
    };

    previous.addEventListener("click", () => scrollByCard(-1));
    next.addEventListener("click", () => scrollByCard(1));

    let scrollFrame = 0;
    track.addEventListener("scroll", () => {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = requestAnimationFrame(updateControls);
    }, { passive: true });

    track.addEventListener("wheel", (event) => {
      const maximum = maximumScroll();
      if (maximum <= edgeTolerance) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const canMove = (delta < 0 && track.scrollLeft > edgeTolerance)
        || (delta > 0 && track.scrollLeft < maximum - edgeTolerance);
      if (!delta || !canMove) return;
      event.preventDefault();
      track.scrollBy({ left: delta, behavior: "auto" });
    }, { passive: false });

    let dragging = false;
    let moved = false;
    let suppressClick = false;
    let pointerStart = 0;
    let scrollStart = 0;
    const finishDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("is-dragging");
      if (track.hasPointerCapture(event.pointerId)) track.releasePointerCapture(event.pointerId);
      if (moved) {
        suppressClick = true;
        window.setTimeout(() => { suppressClick = false; }, 0);
      }
      updateControls();
    };

    track.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0 || maximumScroll() <= edgeTolerance) return;
      dragging = true;
      moved = false;
      pointerStart = event.clientX;
      scrollStart = track.scrollLeft;
      track.setPointerCapture(event.pointerId);
      track.classList.add("is-dragging");
    });
    track.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const distance = event.clientX - pointerStart;
      if (Math.abs(distance) > 4) moved = true;
      if (!moved) return;
      event.preventDefault();
      track.scrollLeft = scrollStart - distance;
    });
    track.addEventListener("pointerup", finishDrag);
    track.addEventListener("pointercancel", finishDrag);
    track.addEventListener("click", (event) => {
      if (!suppressClick) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(updateControls);
      observer.observe(track);
      track.querySelectorAll(".portfolio-card").forEach((card) => observer.observe(card));
    } else {
      window.addEventListener("resize", updateControls);
    }
    window.addEventListener("load", updateControls, { once: true });
    updateControls();
  });

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

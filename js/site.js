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

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // 顶栏：首页滚过首屏后加底色；所有页面显示一条随滚动推进的发光导线。
  const siteHeader = document.querySelector(".site-header");
  if (siteHeader) {
    const wire = document.createElement("span");
    wire.className = "scroll-wire";
    wire.setAttribute("aria-hidden", "true");
    siteHeader.append(wire);
    let ticking = false;
    const updateHeader = () => {
      ticking = false;
      const maximum = document.documentElement.scrollHeight - window.innerHeight;
      const progress = maximum > 0 ? Math.min(1, Math.max(0, window.scrollY / maximum)) : 0;
      wire.style.setProperty("--progress", progress.toFixed(4));
      siteHeader.classList.toggle("is-scrolled", window.scrollY > 24);
    };
    window.addEventListener("scroll", () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(updateHeader);
    }, { passive: true });
    window.addEventListener("resize", updateHeader);
    updateHeader();
  }

  // 卡片表面的灯光跟随鼠标位置。
  document.querySelectorAll(".portfolio-card, .showcase-right, .tool-card").forEach((card) => {
    card.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "mouse") return;
      const bounds = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${event.clientX - bounds.left}px`);
      card.style.setProperty("--my", `${event.clientY - bounds.top}px`);
    });
  });

  // 等宽小标签进入视口时像终端一样“解码”一次；读屏软件始终读到原文。
  const scrambleTargets = document.querySelectorAll(".hero-kicker, .page-kicker, .section-kicker, .work-category-kicker");
  if (!reduceMotion.matches && "IntersectionObserver" in window && scrambleTargets.length) {
    const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>_#";
    const scramble = (element) => {
      const finalText = element.textContent;
      if (!finalText.trim()) return;
      element.setAttribute("aria-label", finalText);
      const totalFrames = 18;
      let frame = 0;
      const step = () => {
        frame += 1;
        const settled = Math.floor((frame / totalFrames) * finalText.length);
        element.textContent = [...finalText].map((character, index) => {
          if (index < settled || character === " " || character === "/") return character;
          return glyphs[Math.floor(Math.random() * glyphs.length)];
        }).join("");
        if (frame < totalFrames) {
          window.requestAnimationFrame(step);
        } else {
          element.textContent = finalText;
        }
      };
      window.requestAnimationFrame(step);
    };
    const scrambleObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        scrambleObserver.unobserve(entry.target);
        scramble(entry.target);
      });
    }, { threshold: 0.6 });
    scrambleTargets.forEach((element) => scrambleObserver.observe(element));
  }

  // 页脚时钟：固定显示北京时间，和站内其他时间口径一致。
  const clocks = document.querySelectorAll("[data-clock]");
  if (clocks.length) {
    const formatter = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const tick = () => {
      const text = `UTC+8 · ${formatter.format(new Date())}`;
      clocks.forEach((clock) => {
        clock.textContent = text;
        clock.hidden = false;
      });
    };
    tick();
    window.setInterval(tick, 30000);
  }

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
    const gallery = strip.closest("[data-showcase-gallery]");
    const stage = strip.closest(".showcase-left")?.querySelector("[data-showcase-stage]");
    const previous = gallery?.querySelector("[data-showcase-scroll-prev]");
    const next = gallery?.querySelector("[data-showcase-scroll-next]");
    if (!stage) return;

    const thumbnails = [...strip.querySelectorAll(".showcase-thumb")];
    const edgeTolerance = 4;
    const updateControls = () => {
      const maximum = Math.max(0, strip.scrollWidth - strip.clientWidth);
      const atStart = maximum <= edgeTolerance || strip.scrollLeft <= edgeTolerance;
      const atEnd = maximum <= edgeTolerance || strip.scrollLeft >= maximum - edgeTolerance;
      if (previous) {
        previous.disabled = atStart;
        previous.setAttribute("aria-disabled", String(atStart));
      }
      if (next) {
        next.disabled = atEnd;
        next.setAttribute("aria-disabled", String(atEnd));
      }
    };
    const activate = (thumbnail) => {
      const source = thumbnail.dataset.src;
      const type = thumbnail.dataset.type;
      if (!source || !["image", "video"].includes(type)) return;

      stage.querySelector("video")?.pause();
      thumbnails.forEach((item) => {
        const active = item === thumbnail;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-current", String(active));
      });

      const media = document.createElement(type === "video" ? "video" : "img");
      media.className = "showcase-main";
      media.src = source;
      if (type === "video") {
        media.controls = true;
        media.preload = "metadata";
        media.playsInline = true;
        media.setAttribute("aria-label", thumbnail.getAttribute("aria-label") || "作品视频");
      } else {
        media.alt = thumbnail.getAttribute("aria-label") || "作品图片";
        media.decoding = "async";
      }
      stage.replaceChildren(media);
      thumbnail.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    };

    thumbnails.forEach((thumbnail) => {
      thumbnail.addEventListener("click", () => {
        activate(thumbnail);
      });
    });

    const scrollPage = (direction) => {
      strip.scrollBy({ left: direction * Math.max(strip.clientWidth * 0.8, 124), behavior: "smooth" });
    };
    previous?.addEventListener("click", () => scrollPage(-1));
    next?.addEventListener("click", () => scrollPage(1));
    strip.addEventListener("scroll", updateControls, { passive: true });
    window.addEventListener("resize", updateControls);
    strip.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = Math.max(0, thumbnails.findIndex((item) => item.getAttribute("aria-current") === "true"));
      const nextIndex = Math.min(
        thumbnails.length - 1,
        Math.max(0, currentIndex + (event.key === "ArrowRight" ? 1 : -1)),
      );
      thumbnails[nextIndex]?.focus();
      if (thumbnails[nextIndex]) activate(thumbnails[nextIndex]);
    });

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startScroll = 0;
    strip.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      dragging = true;
      moved = false;
      startX = event.clientX;
      startScroll = strip.scrollLeft;
    });
    strip.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const distance = event.clientX - startX;
      if (!moved && Math.abs(distance) > 4) {
        moved = true;
        strip.setPointerCapture(event.pointerId);
        strip.classList.add("is-dragging");
      }
      if (!moved) return;
      event.preventDefault();
      strip.scrollLeft = startScroll - distance;
    });
    const finishDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      strip.classList.remove("is-dragging");
      if (strip.hasPointerCapture(event.pointerId)) strip.releasePointerCapture(event.pointerId);
    };
    strip.addEventListener("pointerup", finishDrag);
    strip.addEventListener("pointercancel", finishDrag);
    strip.addEventListener("click", (event) => {
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    }, true);
    window.requestAnimationFrame(updateControls);
  });

  document.querySelectorAll("[data-work-slider]").forEach((slider) => {
    const track = slider.querySelector("[data-work-track]");
    if (!track) return;

    const edgeTolerance = 4;
    const maximumScroll = () => Math.max(0, track.scrollWidth - track.clientWidth);

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
    };

    track.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse" || event.button !== 0 || maximumScroll() <= edgeTolerance) return;
      dragging = true;
      moved = false;
      pointerStart = event.clientX;
      scrollStart = track.scrollLeft;
    });
    track.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const distance = event.clientX - pointerStart;
      if (!moved && Math.abs(distance) > 4) {
        moved = true;
        track.setPointerCapture(event.pointerId);
        track.classList.add("is-dragging");
      }
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

  });
})();

const selectionCheckboxSelector = ".manage-data-selection-checkbox";

export function initializeSelectionCheckboxKeyboard(container) {
    if (!container) {
        return;
    }

    disposeSelectionCheckboxKeyboard(container);

    const onKeyDown = event => {
        if (event.repeat || !isSpaceKey(event)) {
            return;
        }

        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }

        const checkbox = target.closest(selectionCheckboxSelector);
        if (!checkbox || !container.contains(checkbox) || checkbox.getAttribute("aria-disabled") === "true") {
            return;
        }

        // Blazor's preventDefault event modifier applies to every key. Handle Space here
        // so Tab/Shift+Tab keep their native focus behavior while Space cannot scroll or
        // bubble to the grid.
        event.preventDefault();
        event.stopPropagation();
        checkbox.click();
    };

    container.addEventListener("keydown", onKeyDown, true);
    container.manageDataSelectionCheckboxKeyDown = onKeyDown;
}

export function disposeSelectionCheckboxKeyboard(container) {
    const onKeyDown = container?.manageDataSelectionCheckboxKeyDown;
    if (!onKeyDown) {
        return;
    }

    container.removeEventListener("keydown", onKeyDown, true);
    delete container.manageDataSelectionCheckboxKeyDown;
}

function isSpaceKey(event) {
    return event.key === " " ||
        event.key === "Spacebar" ||
        event.code === "Space";
}

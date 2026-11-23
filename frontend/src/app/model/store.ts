import { configureStore, createSlice } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query';
import { useDispatch, useSelector } from 'react-redux';
import { rootApi } from '@/shared/api';

const ui = createSlice({
  name: 'ui',
  initialState: { dark: true },
  reducers: {
    toggleTheme: (state) => {
      state.dark = !state.dark;
    },
  },
});

export const store = configureStore({
  reducer: { ui: ui.reducer, [rootApi.reducerPath]: rootApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(rootApi.middleware),
  // Login is an RTK Query mutation; never send its arguments to Redux DevTools.
  devTools: false,
});
setupListeners(store.dispatch);

export const { toggleTheme } = ui.actions;
export const useAppDispatch = useDispatch.withTypes<typeof store.dispatch>();
export const useAppSelector = useSelector.withTypes<ReturnType<typeof store.getState>>();
